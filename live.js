/* ============================================================
   LIVE GAME SCREEN
   ============================================================ */
let LiveGameId = null;
let _lastLiveGameId = null;
let LiveGameWatchOnly = false;
let _sprayChartVisible = false;
let _sprayBatterId    = null;  // player to show during animation; null = current batter
let _sprayCachedDots  = null;  // snapshot of dots taken before save; prevents new dot from appearing
let _scoringHeartbeat = null;
let _selectedPlayTs = null;
let _returnTab    = null;   // tab to return to after exiting live game overlay
// Undo/redo stacks are stored on the game document in Firestore so any
// authorized scorer on any device can undo/redo.  They are NOT in
// _SNAPSHOT_KEYS so a snapshot restore never overwrites the stack itself.

const _SNAPSHOT_KEYS = [
  // Core play state
  'bases','outs','balls','strikes','fouls',
  'score','lineScore','events',
  'awayBatterIdx','homeBatterIdx',
  'currentInning','currentHalf','status','runnerCounter','isOver',
  // Pitcher rotation state — must be restored so the right pitcher shows after undo
  'awayPositions','homePositions',
  'awayPitcherIdx','homePitcherIdx',
  'awayBattersFaced','homeBattersFaced',
];

function captureSnapshot(g) {
  return _SNAPSHOT_KEYS.reduce((s, k) => {
    s[k] = JSON.parse(JSON.stringify(g[k] ?? null));
    return s;
  }, {});
}

async function undoPlay() {
  if (!await assertScoringLock(LiveGameId)) return;
  const g = State.getGame(LiveGameId); if (!g) return;
  const undoStack = g.undoStack || [];
  if (!undoStack.length) { toast('Nothing to undo', 'error'); return; }
  const snap = undoStack[undoStack.length - 1];
  // Mutate stacks on g BEFORE updateGame — Storage.saveGame(g) persists the full doc
  g.undoStack = undoStack.slice(0, -1);
  g.redoStack = [...(g.redoStack || []), captureSnapshot(g)].slice(-15);
  _cancelAnim();
  await State.updateGame(g.id, snap);  // snap lacks undoStack/redoStack keys → stacks survive
  renderLiveGame(g.id);
  Render.players();
  Render.teams();
  toast('Undone');
}

async function redoPlay() {
  if (!await assertScoringLock(LiveGameId)) return;
  const g = State.getGame(LiveGameId); if (!g) return;
  const redoStack = g.redoStack || [];
  if (!redoStack.length) { toast('Nothing to redo', 'error'); return; }
  const snap = redoStack[redoStack.length - 1];
  g.redoStack = redoStack.slice(0, -1);
  g.undoStack = [...(g.undoStack || []), captureSnapshot(g)].slice(-15);
  _cancelAnim();
  await State.updateGame(g.id, snap);
  renderLiveGame(g.id);
  Render.players();
  Render.teams();
  toast('Redone');
}

function renderLiveGame(gameId, watchOnly = false) {
  const isNewGame = gameId !== _lastLiveGameId;
  if (isNewGame) {
    _liveTab = 'score';
    _prevGameSnap = null;
    _sprayChartVisible = false;
    _sprayBatterId     = null;
    _sprayCachedDots   = null;
    _frozenScore    = null;
    _frozenOuts     = null;
    _frozenBases    = null;
    _frozenHalf     = null;
    _frozenInning   = null;
    _betweenInnings = false;
  }
  _lastLiveGameId = gameId;
  LiveGameId = gameId;
  LiveGameWatchOnly = watchOnly;
  _selectedPlayTs = null;
  const g = State.getGame(gameId);
  if (!g) return;
  const home = State.getTeam(g.homeTeamId);
  const away = State.getTeam(g.awayTeamId);
  const overlay = $('#live-game-overlay');
  if (!_returnTab) _returnTab = _currentTab || 'home';
  if (overlay) {
    // Capture scroll state before blowing away the DOM.
    // For the plays tab: if the user was within 50px of the bottom (or this is a
    // fresh open), we'll auto-scroll to the bottom after render so new entries stay
    // visible.  If they'd scrolled up to review old plays, we restore their position.
    const prevPlEl       = !isNewGame ? document.querySelector('.play-log') : null;
    const prevPlScrollTop = prevPlEl ? prevPlEl.scrollTop : null;
    const isFinished = g.status === 'completed';
    const prevPlAtBottom  = prevPlEl
      ? (prevPlEl.scrollHeight - prevPlEl.scrollTop - prevPlEl.clientHeight) <= 50
      : !isFinished;  // fresh open of live game → scroll to bottom; finished game → start at top
    const prevStEl  = !isNewGame ? document.querySelector('.lg-stats-scroll') : null;
    const prevStScr = prevStEl ? prevStEl.scrollTop : 0;

    overlay.innerHTML = liveGameHTML(g, home, away);
    overlay.classList.add('open');

    // Restore / advance plays-tab scroll
    if (_liveTab === 'plays') {
      const newPlEl = document.querySelector('.play-log');
      if (newPlEl) {
        if (prevPlScrollTop === null || prevPlAtBottom) {
          newPlEl.scrollTop = newPlEl.scrollHeight;   // at bottom → keep at bottom
        } else {
          newPlEl.scrollTop = prevPlScrollTop;         // scrolled up → maintain position
        }
      }
    }
    // Preserve stats-tab scroll position
    const newStEl = document.querySelector('.lg-stats-scroll');
    if (newStEl && prevStScr) newStEl.scrollTop = prevStScr;
  }
  drawField();
  attachPitchHandlers();
  // Initialise animation snapshot when opening a new game
  if (isNewGame) _prevGameSnap = _snapGame(g);
}

function exitLiveGame() {
  stopScoringHeartbeat();
  releaseScoringLock(LiveGameId);
  closeLiveMenu();
  const overlay = $('#live-game-overlay');
  if (overlay) {
    overlay.classList.remove('open');
    overlay.innerHTML = '';
  }
  LiveGameId = null;
  LiveGameWatchOnly = false;
  const returnTo = _returnTab;
  _returnTab = null;
  if (returnTo && returnTo !== 'games') switchTab(returnTo);
}

// ---- Scoring lock ----
// Lock is considered stale after 90 s (slightly more than one heartbeat interval).
// A stale lock can be taken over by another scorer; the original scorer's next
// write will detect the takeover and switch them to watch-only.
const SCORING_LOCK_STALE_MS = 90 * 1000;

function isScoringLockStale(g) {
  if (!g || !g.scoringLockedBy || !g.scoringLockedAt) return false;
  return (Date.now() - g.scoringLockedAt) >= SCORING_LOCK_STALE_MS;
}

async function acquireScoringLock(gameId) {
  if (!currentUser) return false;
  // Always read fresh from Firestore so a second device can't bypass a lock
  // due to stale local state that hasn't received the onSnapshot update yet.
  let g;
  try {
    const fs = window._fs;
    const snap = await fs.getDoc(fs.doc(fs.db, 'games', gameId));
    g = snap.exists() ? snap.data() : null;
  } catch (e) {
    // Fallback to local cache if offline / read fails
    g = State.getGame(gameId);
  }
  if (!g) return false;
  const now = Date.now();
  if (g.scoringLockedBy && g.scoringLockedBy !== currentUser.uid) {
    if (!isScoringLockStale(g)) return false; // someone is actively scoring
    // Stale lock — take over; original scorer will be notified via onSnapshot
  }
  await State.updateGame(gameId, { scoringLockedBy: currentUser.uid, scoringLockedAt: now });
  return true;
}

async function releaseScoringLock(gameId) {
  if (!currentUser || !gameId) return;
  const g = State.getGame(gameId);
  if (g?.scoringLockedBy === currentUser.uid) {
    await State.updateGame(gameId, { scoringLockedBy: null, scoringLockedAt: null });
  }
}

function startScoringHeartbeat(gameId) {
  stopScoringHeartbeat();
  _scoringHeartbeat = setInterval(async () => {
    if (!currentUser || !LiveGameId) return;
    const g = State.getGame(gameId);
    if (g?.scoringLockedBy === currentUser.uid) {
      await State.updateGame(gameId, { scoringLockedAt: Date.now() });
    }
  }, 60000);
}

function stopScoringHeartbeat() {
  if (_scoringHeartbeat) { clearInterval(_scoringHeartbeat); _scoringHeartbeat = null; }
}

// Returns true if the current user still owns a valid (non-stale) scoring lock.
// If someone else has taken over → switches to watch-only and returns false.
// If our own lock is stale → does a fresh Firestore read:
//   • No one else has an active lock → re-acquire and return true (seamless resume)
//   • Someone else has an active lock → switch to watch-only and return false
async function assertScoringLock(gameId) {
  if (!gameId || !currentUser) return false;
  const g = State.getGame(gameId);
  if (!g || g.status === 'completed') return false;
  if (g.scoringLockedBy && g.scoringLockedBy !== currentUser.uid) {
    // Lock is held by someone else per local state — switch to watch-only
    stopScoringHeartbeat();
    LiveGameWatchOnly = true;
    const locker = State.getUser(g.scoringLockedBy);
    toast(`${locker?.name || 'Another user'} took over scoring. You are now watching.`, 'error');
    renderLiveGame(gameId, true);
    return false;
  }
  if (isScoringLockStale(g)) {
    // Our lock is stale — do a fresh read to see if anyone else took over while
    // the tab was backgrounded (local state may not reflect Firestore reality).
    try {
      const fs = window._fs;
      const snap = await fs.getDoc(fs.doc(fs.db, 'games', gameId));
      if (snap.exists()) {
        const d = snap.data();
        const freshBy = d.scoringLockedBy;
        const freshAt = d.scoringLockedAt;
        const freshActive = freshBy && freshAt &&
                            (Date.now() - freshAt) < SCORING_LOCK_STALE_MS;
        if (freshActive && freshBy !== currentUser.uid) {
          // Someone else has an active lock — drop to watch
          stopScoringHeartbeat();
          LiveGameWatchOnly = true;
          const locker = State.getUser(freshBy);
          toast(`${locker?.name || 'Another user'} took over scoring. You are now watching.`, 'error');
          renderLiveGame(gameId, true);
          return false;
        }
      }
    } catch (e) {
      // Can't verify — safe default is to deny the stale action
      console.warn('assertScoringLock: fresh read failed', e);
      stopScoringHeartbeat();
      LiveGameWatchOnly = true;
      toast('Could not verify your scoring session. Please try again.', 'error');
      renderLiveGame(gameId, true);
      return false;
    }
    // Nobody else has an active lock — re-acquire and resume
    await State.updateGame(gameId, { scoringLockedAt: Date.now() });
    startScoringHeartbeat(gameId);
    const banner = document.getElementById('stale-scoring-banner');
    if (banner) banner.remove();
  }
  return true;
}

async function openGameForScoring(gameId) {
  if (!canUserScore()) { renderLiveGame(gameId, true); return; }
  const locked = await acquireScoringLock(gameId);
  if (!locked) {
    const g = State.getGame(gameId);
    const lockerProfile = g?.scoringLockedBy ? State.getUser(g.scoringLockedBy) : null;
    const name = lockerProfile?.name || 'Someone';
    toast(`${name} is already scoring this game`, 'error');
    // Do NOT open the game — leave the user on the current screen
    return;
  }
  startScoringHeartbeat(gameId);
  renderLiveGame(gameId, false);
}

window.addEventListener('beforeunload', () => {
  if (LiveGameId) releaseScoringLock(LiveGameId);
});

// When the user returns to the tab after the phone/browser was backgrounded,
// re-render immediately so the stale-lock banner shows if applicable.
// assertScoringLock will do a fresh Firestore read on the next action to decide
// whether to resume scoring or drop to watch-only.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!LiveGameId || LiveGameWatchOnly || !currentUser) return;
  const g = State.getGame(LiveGameId);
  if (!g || g.status === 'completed') return;
  if (g.scoringLockedBy === currentUser.uid && isScoringLockStale(g)) {
    renderLiveGame(LiveGameId, false);  // show stale banner; next action verifies
  }
});

function renderScorerName(g) {
  // Returns the display name of whoever currently holds the scoring lock,
  // or empty string if the game is completed or nobody has the lock.
  if (g.status === 'completed' || !g.scoringLockedBy) return '';
  const scorer = State.getUser(g.scoringLockedBy);
  return scorer?.name || '';
}

let _liveTab = 'score';

// Deferred-display state — score/outs/bases shown during animations, cleared after
let _frozenScore    = null;   // {away, home} — if set, overrides g.score in scoreboard
let _frozenOuts     = null;   // number — if set, overrides g.outs in scoreboard
let _frozenBases    = null;   // {1,2,3} — if set, overrides g.bases in field SVG
let _betweenInnings = false;  // true while blank-field transition plays between halves
// Scorer-path toast state — held during outcome/EOI animations so the UI stays locked
let _frozenCount     = null;   // { balls, strikes, fouls } — shown during outcome toast
let _frozenBatterId  = null;   // batter to display during outcome toast (pre-play)
let _frozenPitcherId = null;   // pitcher to display during outcome toast (pre-play)
let _frozenHalf      = null;   // currentHalf frozen during outcome/EOI toasts (prevents inning flip)
let _frozenInning    = null;   // currentInning frozen during outcome/EOI toasts
let _animInputLocked = false;  // true while any scoring toast is showing (buttons disabled)
let _pitcherSwapWarningDismissed = false; // true after user confirms early swap; reset each half-inning
let _pendingEndGameDecision = false; // true while end-game dialog is open; blocks SOI animations

function switchLiveTab(tab) {
  _liveTab = tab;
  $$('.lg-pane').forEach(p => { p.hidden = p.dataset.tab !== tab; });
  $$('.lg-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  if (tab === 'plays') {
    requestAnimationFrame(() => {
      const log = document.querySelector('.play-log');
      if (!log) return;
      const g = State.getGame(LiveGameId);
      // Finished games start at the top so you can read from the beginning.
      // Live / watch-only games auto-scroll to the latest play.
      if (!g || g.status !== 'completed') log.scrollTop = log.scrollHeight;
    });
  }
}

function toggleLiveMenu() {
  const m = $('#lg-menu');
  if (m) m.hidden = !m.hidden;
}
function closeLiveMenu() {
  const m = $('#lg-menu');
  if (m) m.hidden = true;
}

let _liveStatsTab = 'hitting';

function switchLiveStatsTab(tab) {
  _liveStatsTab = tab;
  $$('.lg-stats-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  const g = State.getGame(LiveGameId); if (!g) return;
  const content = $('#lg-stats-content');
  if (content) content.innerHTML = renderLiveStatsTable(g, State.getTeam(g.awayTeamId), State.getTeam(g.homeTeamId));
}

function renderLiveStats(g, away, home) {
  const tabs = ['hitting','pitching','fielding'];
  const tabBar = tabs.map(t =>
    `<button class="lg-stats-tab-btn${_liveStatsTab === t ? ' active' : ''}" data-tab="${t}" onclick="switchLiveStatsTab('${t}')">${t[0].toUpperCase()+t.slice(1)}</button>`
  ).join('');
  return `<div class="lg-stats-tabs">${tabBar}</div>
    <div id="lg-stats-content" class="lg-stats-scroll">${renderLiveStatsTable(g, away, home)}</div>`;
}

function renderLiveStatsTable(g, away, home) {
  if (_liveStatsTab === 'pitching') return renderPitchingStats(g, away, home);
  if (_liveStatsTab === 'fielding') return renderFieldingStats(g, away, home);
  return renderHittingStats(g, away, home);
}

function renderHittingStats(g, away, home) {
  const renderTeam = (team, orderKey) => {
    const order = g[orderKey] || [];
    if (!order.length) return `<tr><td colspan="12" class="muted" style="padding:8px;text-align:center">No lineup set</td></tr>`;
    return order.map(pid => {
      const p = State.getPlayer(pid);
      let ab=0, h=0, singles=0, dbl=0, hr=0, bb=0, k=0, fo=0, rbi=0, r=0;
      (g.events || []).forEach(e => {
        if (e.type !== 'pa_end' || e.batterId !== pid) return;
        if (e.outcome === 'BB') { bb++; return; }
        ab++;
        if (e.outcome === '1B') { h++; singles++; }
        else if (e.outcome === '2B') { h++; dbl++; }
        else if (e.outcome === 'HR') { h++; hr++; }
        else if (e.outcome === 'K') k++;
        else if (e.outcome === 'FO') fo++;
        rbi += e.rbi || 0;
        if ((e.runsScoredBy || []).includes(pid)) r++;
      });
      const avg = ab ? (h / ab).toFixed(3).replace(/^0/, '') : '.000';
      return `<tr>
        <td>${escapeHtml(p?.name||'?')}</td>
        <td>${ab}</td><td>${h}</td><td>${avg}</td>
        <td>${singles}</td><td>${dbl}</td><td>${hr}</td>
        <td>${r}</td><td>${rbi}</td><td>${bb}</td><td>${k}</td><td>${fo}</td>
      </tr>`;
    }).join('');
  };
  const hdr = (team) => `<tr class="stats-team-hdr"><th colspan="12">${teamSwatch(team)}${escapeHtml(team.name)}</th></tr>
    <tr class="stats-col-hdr"><th>Player</th><th>AB</th><th>H</th><th>AVG</th><th>1B</th><th>2B</th><th>HR</th><th>R</th><th>RBI</th><th>BB</th><th>K</th><th>FO</th></tr>`;
  return `<table>
    <thead>${hdr(away)}</thead><tbody>${renderTeam(away,'awayBattingOrder')}</tbody>
    <thead>${hdr(home)}</thead><tbody>${renderTeam(home,'homeBattingOrder')}</tbody>
  </table>
  <div class="stats-key">
    <span><strong>AB</strong> At Bats</span>
    <span><strong>H</strong> Hits</span>
    <span><strong>AVG</strong> Batting Average</span>
    <span><strong>1B/2B/HR</strong> Hit Types</span>
    <span><strong>R</strong> Runs Scored</span>
    <span><strong>RBI</strong> Runs Batted In</span>
    <span><strong>BB</strong> Walks</span>
    <span><strong>K</strong> Strikeouts</span>
    <span><strong>FO</strong> Foul Outs</span>
  </div>`;
}

function renderPitchingStats(g, away, home) {
  const renderTeam = (team, positions, pitchingHalf) => {
    // Find all pitchers who actually threw this half (from event log), plus current assigned P
    const teamPidSet = new Set(team.playerIds || []);
    const eventPids = [...new Set(
      (g.events || [])
        .filter(e => e.type === 'pa_end' && e.half === pitchingHalf && e.pitcherId && teamPidSet.has(e.pitcherId))
        .map(e => e.pitcherId)
    )];
    // Fall back to current position assignment if no events yet
    if (!eventPids.length) {
      const curPid = Object.keys(positions || {}).find(pid => (positions||{})[pid] === 'P' && teamPidSet.has(pid));
      if (curPid) eventPids.push(curPid);
    }
    if (!eventPids.length) return `<tr><td colspan="9" class="muted" style="padding:8px;text-align:center">No pitcher assigned</td></tr>`;
    // Determine if the game is currently mid-AB in this pitching half
    const gameInProgress = g.status === 'in_progress';
    const activePitcherId = gameInProgress && pitchingHalf === g.currentHalf
      ? currentPitcherId(g) : null;
    const liveExtraPitches = activePitcherId
      ? (g.balls || 0) + (g.strikes || 0) + (g.fouls || 0) : 0;

    return eventPids.map(pid => {
      const p = State.getPlayer(pid);
      let outs=0, h=0, hr=0, bb=0, k=0, er=0, pitches=0;
      (g.events || []).forEach(e => {
        if (e.type !== 'pa_end' || e.half !== pitchingHalf) return;
        if (e.pitcherId === pid) {
          if (e.outcome === 'OUT' || e.outcome === 'K' || e.outcome === 'FO') outs++;
          if (['1B','2B','3B','HR'].includes(e.outcome)) h++;
          if (e.outcome === 'HR') hr++;
          if (e.outcome === 'BB') bb++;
          if (e.outcome === 'K') k++;
          pitches += e.pitches || 0;
          if (!e.earnedRunsByPitcher) er += e.earnedRuns || 0; // backward compat
        }
        // Inherited runner attribution: pitcher gets ER charged via earnedRunsByPitcher
        if (e.earnedRunsByPitcher) er += e.earnedRunsByPitcher[pid] || 0;
      });
      // Add the current batter's in-progress pitch count to the active pitcher
      if (pid === activePitcherId) pitches += liveExtraPitches;
      const ipOuts = outs;
      const ipStr = `${Math.floor(ipOuts/3)}${ipOuts%3 ? '.'+ipOuts%3 : ''}`;
      const era = ipOuts > 0 ? ((er * 27) / ipOuts).toFixed(2) : '—';
      return `<tr>
        <td>${escapeHtml(p?.name||'?')}</td>
        <td>${ipStr}</td><td>${era}</td>
        <td>${h}</td><td>${hr}</td><td>${bb}</td><td>${k}</td>
        <td>${er}</td><td>${pitches}</td>
      </tr>`;
    }).join('');
  };
  const hdr = (team) => `<tr class="stats-team-hdr"><th colspan="9">${teamSwatch(team)}${escapeHtml(team.name)}</th></tr>
    <tr class="stats-col-hdr"><th>Player</th><th>IP</th><th>ERA</th><th>H</th><th>HR</th><th>BB</th><th>K</th><th>ER</th><th>PC</th></tr>`;
  return `<table>
    <thead>${hdr(away)}</thead><tbody>${renderTeam(away, g.awayPositions, 'bottom')}</tbody>
    <thead>${hdr(home)}</thead><tbody>${renderTeam(home, g.homePositions, 'top')}</tbody>
  </table>
  <div class="stats-key">
    <span><strong>IP</strong> Innings Pitched</span>
    <span><strong>ERA</strong> Earned Run Average (9-inning)</span>
    <span><strong>H</strong> Hits Allowed</span>
    <span><strong>HR</strong> Home Runs Allowed</span>
    <span><strong>BB</strong> Walks</span>
    <span><strong>K</strong> Strikeouts</span>
    <span><strong>ER</strong> Earned Runs</span>
    <span><strong>PC</strong> Pitch Count</span>
  </div>`;
}

function renderFieldingStats(g, away, home) {
  const renderTeam = (team, positions, fieldingHalf) => {
    const ids = team.playerIds || [];
    if (!ids.length) return `<tr><td colspan="5" class="muted" style="padding:8px;text-align:center">No players</td></tr>`;
    const rows = ids.map(pid => {
      const p = State.getPlayer(pid);
      let po=0, err=0, dpAtt=0, dpSuc=0, tagAtt=0, tagSuc=0;
      (g.events || []).forEach(e => {
        if (e.type !== 'pa_end' || e.half !== fieldingHalf) return;
        if (e.fielderId === pid && e.outcome === 'OUT') po++;
        if (e.errorById === pid) err++;
        if (e.fielderId === pid && (e.doublePlay || e.dpAttempted)) { dpAtt++; if (e.doublePlay) dpSuc++; }
        if (e.fielderId === pid && e.sacFly) { tagAtt++; if (e.sacFlyOut) tagSuc++; }
      });
      const dpStr  = dpAtt  > 0 ? `${dpSuc}/${dpAtt}`  : '—';
      const tagStr = tagAtt > 0 ? `${tagSuc}/${tagAtt}` : '—';
      return `<tr><td>${escapeHtml(p?.name||'?')}</td><td>${po}</td><td>${err}</td><td>${dpStr}</td><td>${tagStr}</td></tr>`;
    }).join('');
    return rows;
  };
  const hdr = (team) => `<tr class="stats-team-hdr"><th colspan="5">${teamSwatch(team)}${escapeHtml(team.name)}</th></tr>
    <tr class="stats-col-hdr"><th>Player</th><th>PO</th><th>E</th><th>DP</th><th>TAG</th></tr>`;
  return `<table>
    <thead>${hdr(away)}</thead><tbody>${renderTeam(away, g.awayPositions, 'bottom')}</tbody>
    <thead>${hdr(home)}</thead><tbody>${renderTeam(home, g.homePositions, 'top')}</tbody>
  </table>
  <div class="stats-key">
    <span><strong>PO</strong> Putouts</span>
    <span><strong>E</strong> Errors</span>
    <span><strong>DP</strong> Double Plays (made/attempted)</span>
    <span><strong>TAG</strong> Tag plays (made/attempted)</span>
  </div>`;
}

function liveGameHTML(g, home, away) {
  // Use frozen half/inning during outcome and EOI toasts so the scoreboard doesn't
  // flip to the new inning the moment endHalfInningInternal saves to Firestore.
  const displayHalf   = _frozenHalf   ?? g.currentHalf;
  const displayInning = _frozenInning ?? g.currentInning;
  const battingSide = displayHalf === 'top' ? 'away' : 'home';
  const fieldingTeam = battingSide === 'away' ? home : away;
  const inningStr = (displayHalf === 'top' ? '▲' : '▼') + displayInning;
  const isCompleted = g.status === 'completed';
  const canScore = !LiveGameWatchOnly && canUserScore();
  const batterId = currentBatterId(g);
  const batter = State.getPlayer(batterId);

  const scorePaneHidden = _liveTab !== 'score';
  const playsPaneHidden = _liveTab !== 'plays';
  const statsPaneHidden = _liveTab !== 'stats';

  return `
    <div class="live-game">
      <div class="lg-topbar">
        <button class="btn-icon lg-back-btn" onclick="exitLiveGame()" title="Back">←</button>
        <div class="lg-title">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:nowrap;min-width:0">
            <span class="game-card-status status-${g.status}" style="font-size:11px;flex-shrink:0">${isCompleted ? 'Final' : canScore ? 'Scoring' : 'Live'}</span>
            ${(function(){ const n = !canScore && renderScorerName(g); return n ? `<span style="font-size:11px;color:#166534;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">🟢 ${escapeHtml(n)}</span>` : ''; })()}
          </div>
          ${g.tournamentId ? `<div style="font-size:11px;color:#0369a1;font-weight:500;margin-top:2px">📋 ${escapeHtml(State.getTournament(g.tournamentId)?.name || g.tournamentName || '')}</div>` : ''}
        </div>
        ${isCompleted && isAdmin() ? `
        <div style="display:flex;gap:6px;flex-shrink:0">
          <button class="btn btn-sm" onclick="showEditScoreModal('${g.id}')">✏️ Edit</button>
          <button class="btn btn-sm btn-warning" onclick="reopenGame('${g.id}')">↺ Reopen</button>
        </div>` : ''}
        ${!isCompleted && canScore ? `
        <div class="lg-menu-wrap">
          <button class="btn-icon lg-menu-btn" onclick="toggleLiveMenu()">⋮</button>
          <div class="lg-menu" id="lg-menu" hidden>
            <button onclick="endHalfInning('${g.id}');closeLiveMenu()">End half inning</button>
            <button onclick="endGameEarly('${g.id}');closeLiveMenu()" style="color:#dc2626">End game</button>
            <div class="lg-menu-divider"></div>
            <button onclick="swapHomeAway('${g.id}');closeLiveMenu()"
              ${((g.events||[]).length > 0 || g.balls > 0 || g.strikes > 0 || (g.fouls||0) > 0) ? 'disabled' : ''}>⇄ Swap Home/Away</button>
          </div>
        </div>` : ''}
      </div>


      <div class="scoreboard">
        <div class="team-side ${battingSide === 'away' && !isCompleted ? 'batting' : ''}">
          <div class="name">${teamSwatch(away)}${escapeHtml(away.name)}</div>
          <div class="score" id="sb-score-away">${(_frozenScore || g.score).away}</div>
        </div>
        <div class="middle">
          <div class="inning" id="sb-inning">${isCompleted ? 'FINAL' : inningStr}</div>
          <div class="outs" id="sb-outs">${isCompleted ? '' : (function(){const o=_frozenOuts??g.outs;return`<span class="outs-label">Outs</span><span class="out-dots"><span class="out-dot${o>=1?' on':''}"></span><span class="out-dot${o>=2?' on':''}"></span><span class="out-dot${o>=3?' on':''}"></span></span>`;})()}</div>
        </div>
        <div class="team-side ${battingSide === 'home' && !isCompleted ? 'batting' : ''}">
          <div class="name">${teamSwatch(home)}${escapeHtml(home.name)}</div>
          <div class="score" id="sb-score-home">${(_frozenScore || g.score).home}</div>
        </div>
        ${!isCompleted ? `
        <div class="sb-counts">
          <div class="count-block"><span class="label">Balls</span><span class="val" id="count-b">${_frozenCount?.balls ?? g.balls}</span></div>
          <div class="count-block"><span class="label">Strikes</span><span class="val" id="count-s">${_frozenCount?.strikes ?? g.strikes}</span></div>
          <div class="count-block"><span class="label">Fouls</span><span class="val" id="count-f">${(_frozenCount?.fouls ?? g.fouls) || 0}</span></div>
        </div>` : ''}
      </div>

      <div class="lg-tab-body">
        <div class="lg-pane" data-tab="score" ${scorePaneHidden ? 'hidden' : ''}>
          ${canScore && isScoringLockStale(g) ? `<div id="stale-scoring-banner" style="background:#fef9c3;border-bottom:1px solid #fde68a;padding:8px 14px;font-size:12px;color:#92400e">⚠️ Scoring session timed out. Press any pitch button — if no one else took over, you'll resume automatically.</div>` : ''}
          ${!isCompleted ? renderMatchupStrip(g, _betweenInnings) : ''}
          <div class="field-wrap">
            <div class="field-and-bases">
              <div class="field-panel">
                <div id="field-container"></div>
                <div id="bip-instruction" class="bip-instruction"${__bipStep !== 'locate' ? ' hidden' : ''}>
                  <span class="bip-instruction-text">${
                    __bipKind === 'out'   ? 'Drag fielder to where the play happened' :
                    __bipKind === 'error' ? 'Drag fielder to where the error happened' :
                    __bipKind === 'hr'    ? 'Tap where the ball left the field' :
                                            'Tap where the ball landed'
                  }</span>
                  <button class="bip-instruction-cancel" onclick="bipCancel()">✕</button>
                </div>
                ${!isCompleted && batterId ? `
                <div class="spray-chart-controls">
                  <button class="btn-icon spray-toggle-btn${_sprayChartVisible ? ' active' : ''}" id="spray-toggle-btn" onclick="toggleSprayChart()" title="Toggle hit chart">📍 Hit Chart</button>
                  <div id="spray-chart-key" class="spray-chart-key" style="visibility:${_sprayChartVisible ? 'visible' : 'hidden'}">
                    <div class="spray-key-title">HIT CHART</div>
                    <div class="spray-key-grid">
                      <span class="spray-key-item"><span class="spray-key-dot" style="background:#4ade80"></span>Single</span>
                      <span class="spray-key-item"><span class="spray-key-dot" style="background:#60a5fa"></span>Double</span>
                      <span class="spray-key-item"><span class="spray-key-dot" style="background:#fde68a"></span>HR</span>
                      <span class="spray-key-item"><span class="spray-key-dot" style="background:#fb923c"></span>Out/Error</span>
                    </div>
                  </div>
                </div>` : ''}
                ${!isCompleted && canScore ? `
                <button class="btn-icon field-undo-btn" onclick="undoPlay()" ${(!_animInputLocked && g.undoStack?.length > 0) ? '' : 'disabled'} title="Undo">↩</button>
                <button class="btn-icon field-redo-btn" onclick="redoPlay()" ${(!_animInputLocked && g.redoStack?.length > 0) ? '' : 'disabled'} title="Redo">↪</button>` : ''}
              </div>
            </div>
          </div>
          ${!isCompleted && canScore ? `<div id="bip-panel">${renderBipPanel(g)}</div>` : ''}
          ${isCompleted ? renderAccolades(g) : ''}
        </div>

        <div class="lg-pane" data-tab="plays" ${playsPaneHidden ? 'hidden' : ''}>
          <div class="play-log" style="flex:1;overflow-y:auto;border-radius:0;box-shadow:none;background:#fff">
            <table id="play-log-list" style="width:100%;border-collapse:collapse">${renderPlayLog(g)}</table>
          </div>
        </div>

        <div class="lg-pane" data-tab="stats" ${statsPaneHidden ? 'hidden' : ''}>
          <div class="lg-stats">${renderLiveStats(g, away, home)}</div>
        </div>
      </div>

      <div class="lg-tab-bar">
        <button class="lg-tab-btn ${_liveTab === 'score' ? 'active' : ''}" data-tab="score" onclick="switchLiveTab('score')">Score</button>
        <button class="lg-tab-btn ${_liveTab === 'plays' ? 'active' : ''}" data-tab="plays" onclick="switchLiveTab('plays')">Plays</button>
        <button class="lg-tab-btn ${_liveTab === 'stats' ? 'active' : ''}" data-tab="stats" onclick="switchLiveTab('stats')">Stats</button>
      </div>
    </div>
  `;
}

function renderPitcherRow(g) {
  const pitcherId = currentPitcherId(g);
  const pitcher = pitcherId ? State.getPlayer(pitcherId) : null;
  return `
    <div style="margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #f3f4f6">
      <span class="player-num">#${escapeHtml(pitcher?.jerseyNumber || '-')}</span>
      <span>${escapeHtml(pitcher?.name || '?')}</span>
      <div class="game-stats">${pitcherId ? pitcherGameStats(g, pitcherId) : ''}</div>
    </div>
  `;
}

function batterGameStats(g, batterId) {
  let ab = 0, h = 0, bb = 0, k = 0, fo = 0, rbi = 0;
  (g.events || []).forEach(e => {
    if (e.type !== 'pa_end' || e.batterId !== batterId) return;
    if (e.outcome === 'BB') { bb++; return; }
    ab++;
    if (['1B','2B','3B','HR'].includes(e.outcome)) h++;
    if (e.outcome === 'K')  k++;
    if (e.outcome === 'FO') fo++;
    rbi += e.rbi || 0;
  });
  const parts = [`${h}-${ab}`];
  if (bb)  parts.push(`${bb} BB`);
  if (k)   parts.push(`${k} K`);
  if (fo)  parts.push(`${fo} FO`);
  if (rbi) parts.push(`${rbi} RBI`);
  return parts.join(', ');
}

function batterMatchupStats(g, batterId) {
  let ab = 0, h = 0, bb = 0, hr = 0, rbi = 0;
  (g.events || []).forEach(e => {
    if (e.type !== 'pa_end' || e.batterId !== batterId) return;
    if (e.outcome === 'BB') { bb++; return; }
    ab++;
    if (['1B','2B','3B','HR'].includes(e.outcome)) h++;
    if (e.outcome === 'HR') hr++;
    rbi += e.rbi || 0;
  });
  const parts = [`${h} for ${ab}`];
  if (rbi) parts.push(`${rbi} RBI`);
  if (hr)  parts.push(`${hr} HR`);
  if (bb)  parts.push(`${bb} BB`);
  return parts.join(' · ') || '0 for 0';
}

function pitcherMatchupStats(g, pitcherId) {
  let pitches = 0, k = 0, fo = 0, bb = 0, er = 0;
  (g.events || []).forEach(e => {
    if (e.type !== 'pa_end') return;
    if (e.pitcherId === pitcherId) {
      pitches += e.pitches || 0;
      if (e.outcome === 'K')  k++;
      if (e.outcome === 'FO') fo++;
      if (e.outcome === 'BB') bb++;
      if (!e.earnedRunsByPitcher) er += e.earnedRuns || 0; // backward compat
    }
    if (e.earnedRunsByPitcher) er += e.earnedRunsByPitcher[pitcherId] || 0;
  });
  const parts = [`${pitches} pitches`];
  if (k)  parts.push(`${k} K`);
  if (fo) parts.push(`${fo} FO`);
  if (bb) parts.push(`${bb} BB`);
  if (er) parts.push(`${er} ER`);
  return parts.join(' · ');
}

function renderMatchupStrip(g, hidden = false) {
  const batterId  = _frozenBatterId  || currentBatterId(g);
  const pitcherId = _frozenPitcherId || currentPitcherId(g);
  const batter  = State.getPlayer(batterId);
  const pitcher = State.getPlayer(pitcherId);
  const canScore = !LiveGameWatchOnly && canUserScore();
  const batterName = batter
    ? `<span class="matchup-num">#${escapeHtml(batter.jerseyNumber || '-')}</span> ${escapeHtml(batter.name)}`
    : '?';
  const pn = pitcher ? `<span class="matchup-num">#${escapeHtml(pitcher.jerseyNumber || '-')}</span> ${escapeHtml(pitcher.name)}` : '?';
  return `
    <div class="lg-matchup-strip"${hidden ? ' style="visibility:hidden"' : ''}>
      <div class="lg-matchup-side">
        <div class="lg-matchup-label">At bat</div>
        <div class="lg-matchup-name">${batterName}</div>
        <div class="lg-matchup-stats">${batterId ? batterMatchupStats(g, batterId) : '—'}</div>
      </div>
      <div class="lg-matchup-side lg-matchup-right">
        <div class="lg-matchup-label">Pitching</div>
        <div class="lg-matchup-name">${pn}</div>
        <div class="lg-matchup-stats">${pitcherId ? pitcherMatchupStats(g, pitcherId) : '—'}</div>
      </div>
    </div>`;
}

function pitcherGameStats(g, pitcherId) {
  let k = 0, fo = 0, bb = 0, h = 0, er = 0;
  (g.events || []).forEach(e => {
    if (e.type !== 'pa_end') return;
    if (e.pitcherId === pitcherId) {
      if (e.outcome === 'K')  k++;
      if (e.outcome === 'FO') fo++;
      if (e.outcome === 'BB') bb++;
      if (['1B','2B','3B','HR'].includes(e.outcome)) h++;
      if (!e.earnedRunsByPitcher) er += e.earnedRuns || 0; // backward compat
    }
    if (e.earnedRunsByPitcher) er += e.earnedRunsByPitcher[pitcherId] || 0;
  });
  const parts = [`${k} K`];
  if (fo) parts.push(`${fo} FO`);
  return [...parts, `${bb} BB`, `${h} H`, `${er} ER`].join(' · ');
}

function rerenderLive() {
  if (!LiveGameId) return;
  const g = State.getGame(LiveGameId);

  // If we think we're scoring but another user just took our lock, switch to watch-only
  // immediately on snapshot arrival — before any render — so the UI is correct.
  if (!LiveGameWatchOnly && currentUser && g) {
    if (g.scoringLockedBy && g.scoringLockedBy !== currentUser.uid) {
      stopScoringHeartbeat();
      LiveGameWatchOnly = true;
      const name = State.getUser(g.scoringLockedBy)?.name || 'Another user';
      toast(`${name} took over scoring. You are now watching.`, 'error');
    }
  }

  // Detect changes and queue animations (watch-only mode only)
  if (g && _prevGameSnap && LiveGameWatchOnly) {
    _detectAndQueueAnims(g, _prevGameSnap);
  }
  _prevGameSnap = g ? _snapGame(g) : null;
  renderLiveGame(LiveGameId, LiveGameWatchOnly); // scroll preservation handled inside renderLiveGame
}

function renderBatterRow(g) {
  const batterId = _frozenBatterId || currentBatterId(g);
  const batter = State.getPlayer(batterId);
  const canScore = !LiveGameWatchOnly && canUserScore();
  const nameEl = canScore
    ? `<span class="player-name batter-skip-btn" onclick="showSkipBatterModal()" title="Click to skip this batter">${escapeHtml(batter?.name || '?')} <span style="font-size:10px;color:#9ca3af">⏭</span></span>`
    : `<span class="player-name">${escapeHtml(batter?.name || '?')}</span>`;
  return `
    <div class="at-bat-row">
      <div>
        <span class="player-num">#${escapeHtml(batter?.jerseyNumber || '-')}</span>
        ${nameEl}
        <div class="game-stats">${batterId ? batterGameStats(g, batterId) : ''}</div>
      </div>
    </div>
  `;
}

function renderPlayLog(g) {
  const events = (g.events || []).filter(e => e.type === 'pa_end');
  if (!events.length) {
    // Show the current half-inning header so the tab is never completely blank
    const halfLabel = g.currentHalf === 'top' ? '▲' : '▼';
    return `<tr class="play-inning-break"><td colspan="3">${halfLabel} ${ordinal(g.currentInning)}</td></tr>`;
  }
  const isCompleted = g.status === 'completed';
  const parts = [];
  let lastKey = null;
  let lastPitcherId = null;

  // Pre-compute the score at the START of each half-inning.
  const halfStartScores = {};
  let prevScore = { away: 0, home: 0 };
  events.forEach(e => {
    const k = e.inning + '-' + e.half;
    if (!halfStartScores[k]) halfStartScores[k] = { ...prevScore };
    if (e.scoreAfter) prevScore = e.scoreAfter;
  });

  const _span3 = (cls, content) => `<tr class="${cls}"><td colspan="3">${content}</td></tr>`;

  events.forEach(e => {
    const key = e.inning + '-' + e.half;

    if (key !== lastKey) {
      if (lastKey !== null) {
        const [prevInn, prevHalf] = lastKey.split('-');
        // Only show end-of-inning separator after the bottom half (full inning complete)
        if (prevHalf === 'bottom') {
          parts.push(_span3('play-inning-break play-inning-end', `— End of ${ordinal(parseInt(prevInn))} inning —`));
        }
      }
      const startScore = halfStartScores[key];
      const scoreTag = startScore ? ` <span class="play-inning-score">${startScore.away}–${startScore.home}</span>` : '';
      parts.push(_span3('play-inning-break', `${e.half === 'top' ? '▲' : '▼'} ${ordinal(e.inning)}${scoreTag}`));
      lastKey = key;
      lastPitcherId = null;
      if (e.pitcherId) {
        const pitcher = State.getPlayer(e.pitcherId);
        parts.push(_span3('play-pitcher-entry', `⚾ ${escapeHtml(pitcher?.name || '?')} pitching`));
        lastPitcherId = e.pitcherId;
      }
    } else if (e.pitcherId && e.pitcherId !== lastPitcherId) {
      const pitcher = State.getPlayer(e.pitcherId);
      parts.push(_span3('play-pitcher-change', `⚾ ${escapeHtml(pitcher?.name || '?')} now pitching`));
      lastPitcherId = e.pitcherId;
    }

    const batter = State.getPlayer(e.batterId);

    const outcomeClass = { K: 'play-outcome--out', FO: 'play-outcome--out', OUT: 'play-outcome--out',
      ERR_REACH: 'play-outcome--error',
      '1B': 'play-outcome--hit', '2B': 'play-outcome--hit',
      '3B': 'play-outcome--hit', HR: 'play-outcome--hit',
      BB: 'play-outcome--walk' }[e.outcome] || '';

    const _fielderSpan = (pid) => { const f = State.getPlayer(pid); return f ? ` <span class="play-fielder">by ${escapeHtml(f.name)}</span>` : ''; };
    let fielderStr = '';
    if (e.outcome === 'OUT' && e.fielderId)            fielderStr = _fielderSpan(e.fielderId);
    else if (e.outcome === 'ERR_REACH' && e.errorById) fielderStr = _fielderSpan(e.errorById);

    const runsScored  = (e.runsScoredBy || []).length;
    const sacFlyScored = e.sacFly && !e.sacFlyOut && runsScored > 0;
    const runsPill = runsScored > 0 && !sacFlyScored
      ? `<span class="play-runs-pill">+${runsScored} run${runsScored !== 1 ? 's' : ''}</span>` : '';

    // Extras as separate <tr> rows so they align under the outcome column
    const extraRows = [];
    const isOut = e.outcome === 'K' || e.outcome === 'FO' || e.outcome === 'OUT';
    const rowCls = `play-entry-extra${isOut ? ' play-entry--out' : ''}`;
    if (e.doublePlay) {
      extraRows.push(`<tr class="${rowCls}"><td></td><td colspan="2"><span class="play-extras play-extras--out">Double play</span></td></tr>`);
    } else if (e.dpAttempted) {
      extraRows.push(`<tr class="play-entry-extra"><td></td><td colspan="2"><span class="play-extras">DP attempted — runner safe</span></td></tr>`);
    }
    if (sacFlyScored) {
      const pill = `<span class="play-runs-pill">+${runsScored} run${runsScored !== 1 ? 's' : ''}</span>`;
      extraRows.push(`<tr class="play-entry-extra"><td></td><td colspan="2"><span class="play-extras play-extras--run">Runner tagged up ${pill}</span></td></tr>`);
    } else if (e.sacFlyOut) {
      extraRows.push(`<tr class="${rowCls}"><td></td><td colspan="2"><span class="play-extras play-extras--out">Runner caught tagging up</span></td></tr>`);
    }
    const hasExtras = extraRows.length > 0;

    const countVal = e.countBalls !== undefined
      ? `${e.countBalls}-${e.countStrikes}-${e.countFouls ?? 0}` : '';

    const tsAttr    = isCompleted ? `data-ts="${e.ts}"` : '';
    const clickAttr = isCompleted ? `onclick="selectPlay(${e.ts})"` : '';

    const outcomeText = (() => {
      const map = { BB:'Walk', K:'Strikeout', '1B':'Single', '2B':'Double', '3B':'Triple',
        HR:'Home Run', OUT:`Out${e.hitType ? ' (' + hitTypeLabel(e.hitType) + ')' : ''}`,
        ERR_REACH:`Reached on error${e.errBase ? ' (' + e.errBase + ')' : ''}` };
      return map[e.outcome] || e.outcome;
    })();

    const mainCls = `play-entry${isCompleted ? ' clickable' : ''}${isOut ? ' play-entry--out' : ''}${hasExtras ? ' has-extras' : ''}`;
    parts.push(
      `<tr class="${mainCls}" ${tsAttr} ${clickAttr}>` +
        `<td class="pe-name">${escapeHtml(batter?.name || '?')}</td>` +
        `<td class="pe-mid"><span class="play-outcome ${outcomeClass}">${outcomeText}</span>${fielderStr}${runsPill}</td>` +
        `<td class="pe-count">${countVal}</td>` +
      `</tr>`,
      ...extraRows
    );
  });

  // Close out the last half-inning
  if (lastKey !== null) {
    const [lastInn, lastHalf] = lastKey.split('-');
    if (isCompleted) {
      const away   = State.getTeam(g.awayTeamId);
      const home   = State.getTeam(g.homeTeamId);
      const winner = g.score.away > g.score.home ? away : g.score.home > g.score.away ? home : null;
      const gameEndText = winner ? `🏆 ${escapeHtml(winner.name)} win! ${g.score.away}–${g.score.home}` : `🏁 Final — Tie ${g.score.away}–${g.score.home}`;
      // Only show "End of Nth inning" when the bottom half finished (full inning done)
      if (lastHalf === 'bottom') {
        parts.push(_span3('play-inning-break play-inning-end', `— End of ${ordinal(parseInt(lastInn))} inning —`));
      }
      parts.push(_span3('play-game-end', gameEndText));
    }
  }

  // For in-progress games: show current inning header before any plays are recorded
  if (!isCompleted) {
    const curKey = g.currentInning + '-' + g.currentHalf;
    if (lastKey !== curKey) {
      if (lastKey !== null) {
        const [prevInn, prevHalf] = lastKey.split('-');
        // Only show end-of-inning separator after the bottom half (full inning complete)
        if (prevHalf === 'bottom') {
          parts.push(_span3('play-inning-break play-inning-end', `— End of ${ordinal(parseInt(prevInn))} inning —`));
        }
      }
      const curHalf  = g.currentHalf === 'top' ? '▲' : '▼';
      const scoreTag = ` <span class="play-inning-score">${g.score.away}–${g.score.home}</span>`;
      parts.push(_span3('play-inning-break', `${curHalf} ${ordinal(g.currentInning)}${scoreTag}`));
    }

    // Live at-bat row: show when pitches have been thrown but the at-bat isn't over.
    // Gate on the REAL count (g.balls/strikes/fouls) so this row disappears the moment
    // the pa_end is saved (which resets them to 0) and the regular outcome row takes over.
    // Display the FROZEN count when set so it animates in sync with the scoreboard.
    const realBalls   = g.balls   || 0;
    const realStrikes = g.strikes || 0;
    const realFouls   = g.fouls   || 0;
    if (realBalls > 0 || realStrikes > 0 || realFouls > 0) {
      const dispBalls   = _frozenCount?.balls   ?? realBalls;
      const dispStrikes = _frozenCount?.strikes ?? realStrikes;
      const dispFouls   = _frozenCount?.fouls   ?? realFouls;
      const liveBatterId = _frozenBatterId || currentBatterId(g);
      const liveBatter   = State.getPlayer(liveBatterId);
      parts.push(
        `<tr class="play-entry play-entry--live">` +
          `<td class="pe-name">${escapeHtml(liveBatter?.name || '?')}</td>` +
          `<td class="pe-mid"></td>` +
          `<td class="pe-count">${dispBalls}-${dispStrikes}-${dispFouls}</td>` +
        `</tr>`
      );
    }
  }

  return parts.join('');
}

function describeOutcome(e) {
  const map = {
    'BB': 'Walk',
    'K': 'Strikeout',
    'FO': 'Foul Out',
    '1B': 'Single',
    '2B': 'Double',
    '3B': 'Triple',
    'HR': 'Home Run',
    'OUT': `Out${e.hitType ? ' (' + hitTypeLabel(e.hitType) + ')' : ''}`,
    'ERR_REACH': `Reached on error${e.errBase ? ' (' + e.errBase + ')' : ''}`,
  };
  let s = map[e.outcome] || e.outcome;
  if (e.rbi) s += ` · ${e.rbi} RBI`;
  return s;
}
function hitTypeLabel(t) {
  return ({ GB: 'ground ball', LD: 'line drive', FB: 'fly ball' })[t] || t;
}

function ordinal(n) {
  const s = ['th','st','nd','rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function replayToEvent(g, targetPaIdx) {
  const paEvents = (g.events || []).filter(e => e.type === 'pa_end');
  let bases = { 1: null, 2: null, 3: null };
  let score = { home: 0, away: 0 };
  let outs = 0, runnerCounter = 0, prevKey = null;
  for (let i = 0; i <= targetPaIdx; i++) {
    const e = paEvents[i];
    const key = e.inning + '-' + e.half;
    if (prevKey !== null && key !== prevKey) { bases = { 1: null, 2: null, 3: null }; outs = 0; }
    prevKey = key;
    runnerCounter++;
    const player = State.getPlayer(e.batterId);
    const br = { id: 'rp_' + i, playerId: e.batterId, name: player ? player.name.split(' ')[0] : '?', number: runnerCounter };
    let runsCount = 0;
    if (e.outcome === 'BB') {
      const res = walkAdvance(bases, br); bases = res.newBases; runsCount = res.runnerIdsScored.length;
    } else if (e.outcome === 'K' || e.outcome === 'FO' || e.outcome === 'OUT') {
      outs++;
    } else if (['1B','2B','3B','HR'].includes(e.outcome)) {
      const res = hitAdvance(bases, ({ '1B':1,'2B':2,'3B':3,'HR':4 })[e.outcome], br);
      bases = res.newBases; runsCount = res.runnerIdsScored.length;
    } else if (e.outcome === 'ERR_REACH') {
      const res = advanceRunners(bases, ({ '1B':1,'2B':2,'3B':3,'HR':4 })[e.errBase] || 1, br);
      bases = res.newBases; runsCount = res.runnerIdsScored.length;
    }
    if (e.half === 'top') score.away += runsCount; else score.home += runsCount;
  }
  return { bases, score, outs };
}

function selectPlay(ts) {
  const g = State.getGame(LiveGameId);
  if (!g || g.status !== 'completed') return;
  const paEvents = (g.events || []).filter(e => e.type === 'pa_end');
  const targetIdx = paEvents.findIndex(e => e.ts === ts);
  if (targetIdx < 0) return;
  const event = paEvents[targetIdx];
  if (_selectedPlayTs === ts) { clearPlaySelection(g); return; }
  _selectedPlayTs = ts;

  let bases, score, outs;
  if (event.basesAfter) {
    bases = event.basesAfter; score = event.scoreAfter || g.score; outs = event.outsAfter ?? 0;
  } else {
    const r = replayToEvent(g, targetIdx); bases = r.bases; score = r.score; outs = r.outs;
  }

  $$('.play-entry').forEach(li => li.classList.toggle('selected', li.dataset.ts === String(ts)));
  drawField(bases);
  drawBases(bases);

  const sbAway = $('#sb-score-away'), sbHome = $('#sb-score-home');
  if (sbAway) sbAway.textContent = score.away;
  if (sbHome) sbHome.textContent = score.home;
  const sbInning = $('#sb-inning');
  if (sbInning) sbInning.textContent = (event.half === 'top' ? '▲' : '▼') + event.inning;
  const sbOuts = $('#sb-outs');
  if (sbOuts) sbOuts.innerHTML = `<span class="outs-label">Outs</span><span class="out-dots"><span class="out-dot${outs >= 1 ? ' on' : ''}"></span><span class="out-dot${outs >= 2 ? ' on' : ''}"></span><span class="out-dot${outs >= 3 ? ' on' : ''}"></span></span>`;

  const banner = $('#replay-banner');
  if (banner) {
    const batter = State.getPlayer(event.batterId);
    banner.style.display = 'flex';
    banner.innerHTML = `<span>▶ ${event.half === 'top' ? 'T' : 'B'}${event.inning} — ${escapeHtml(batter?.name || '?')} — ${describeOutcome(event)}</span><button class="btn btn-sm" onclick="clearPlaySelection()">Reset view</button>`;
  }
}

function clearPlaySelection(g) {
  if (!g) g = State.getGame(LiveGameId);
  _selectedPlayTs = null;
  $$('.play-entry').forEach(li => li.classList.remove('selected'));
  drawField(null);
  drawBases(null);
  const sbAway = $('#sb-score-away'), sbHome = $('#sb-score-home');
  if (sbAway && g) sbAway.textContent = g.score.away;
  if (sbHome && g) sbHome.textContent = g.score.home;
  const sbInning = $('#sb-inning');
  if (sbInning) sbInning.textContent = 'FINAL';
  const sbOuts = $('#sb-outs');
  if (sbOuts) sbOuts.innerHTML = ''; // game over — outs not shown in FINAL state
  const banner = $('#replay-banner');
  if (banner) banner.style.display = 'none';
}

/* ============================================================
   FIELD DIAMOND (SVG)
   ============================================================ */
// Coordinates map Field.svg (1733×1911) → 400×400 display (×400/1733, ×400/1911).
// Key Field.svg anchors: foul-line origin (866,1452), bases at their path centres,
// pitcher's rubber rect centre (866,1116).
// Coordinates map Field.svg (1510×1696) → 400×400 display (×400/1510, ×400/1696).
const FIELD = {
  HOME:    { x: 200, y: 331 },   // foul-line origin / batter-box top (753,1402)
  FIRST:   { x: 262, y: 254 },   // 1st base centre (987,1076)
  SECOND:  { x: 200, y: 162 },   // 2nd base centre (753,686)
  THIRD:   { x: 138, y: 254 },   // 3rd base centre (522,1076)
  MOUND:   { x: 200, y: 244 },   // pitcher's rubber centre (754,1067) −8 half-radius
  CF_HOME: { x: 200, y:  53 },   // deep centre field (−3× r=16 from previous)
};

/* ============================================================
   LIVE PLAY ANIMATIONS  (watch mode only)
   ============================================================ */
let _prevGameSnap  = null;   // snapshot before last Firestore push
const _animQueue   = [];
let   _animRunning = false;
let   _animGen     = 0;   // incremented on every cancel; stale callbacks check this
let   _animFielderPid = null; // player id currently being animated — suppressed in drawField()

function _snapGame(g) {
  if (!g) return null;
  const positions = fieldingPositions(g) || {};
  const pitcherId = Object.keys(positions).find(pid => positions[pid] === 'P') || null;
  return {
    eventsLen:     (g.events || []).length,
    balls:         g.balls   || 0,
    strikes:       g.strikes || 0,
    fouls:         g.fouls   || 0,
    score:         { ...(g.score || { away: 0, home: 0 }) },
    outs:          g.outs    || 0,
    bases:         JSON.parse(JSON.stringify(g.bases || {})),
    status:        g.status  || 'setup',
    currentInning: g.currentInning || 1,
    currentHalf:   g.currentHalf   || 'top',
    pitcherId,
    batterId:      currentBatterId(g) || null,
  };
}

function _queueAnim(item) {
  _animQueue.push(item);
  if (!_animRunning) _nextAnim();
}

function _nextAnim() {
  if (!_animQueue.length) { _animRunning = false; return; }
  _animRunning = true;
  const item = _animQueue.shift();
  // fn items are synchronous callbacks — run immediately and advance queue
  if (typeof item.fn === 'function') { item.fn(); _nextAnim(); return; }
  _runAnim(item);
}

// Immediately abort any running/queued animation (used by scorer on new action).
function _cancelAnim() {
  _animGen++;           // invalidate all pending setTimeout / rAF callbacks
  _animQueue.length = 0;
  _animRunning = false;
  // Clear any frozen display state — the new action will set its own
  _frozenScore     = null;
  _frozenOuts      = null;
  _frozenBases     = null;
  _betweenInnings  = false;
  _frozenCount     = null;
  _frozenBatterId  = null;
  _frozenPitcherId = null;
  _frozenHalf      = null;
  _frozenInning    = null;
  _animInputLocked = false;
  const overlay   = document.getElementById('play-anim-overlay');
  const ballEl    = document.getElementById('anim-ball');
  const fielderEl = document.getElementById('anim-fielder');
  const bannerEl  = document.getElementById('anim-banner');
  if (overlay)   overlay.style.display  = 'none';
  if (ballEl)    { ballEl.style.transition = 'none'; ballEl.style.display = 'none'; }
  if (fielderEl) { fielderEl.style.transition = 'none'; fielderEl.style.display = 'none'; }
  if (bannerEl)  { bannerEl.style.transition = 'none'; bannerEl.style.opacity = '0'; }
  // Restore the suppressed fielder and release spray lock if animation was cut short
  if (_animFielderPid || _sprayBatterId) {
    _animFielderPid  = null;
    _sprayBatterId   = null;
    _sprayCachedDots = null;
    drawField();
  }
}

// Convert SVG 0-400 user coords → screen pixels via the CTM.
// getScreenCTM() correctly accounts for viewBox letterboxing and any CSS transforms.
function _svgToScreen(svgEl, sx, sy) {
  const pt = svgEl.createSVGPoint();
  pt.x = sx; pt.y = sy;
  const s = pt.matrixTransform(svgEl.getScreenCTM());
  return { x: s.x, y: s.y };
}

// Returns { initials, startSvg } for the given player id in context of game g,
// or null if fid is falsy.  Position P → starts at MOUND; CF → starts at CF_HOME.
function _getFielderInfo(fid, g) {
  if (!fid || !g) return null;
  const player    = State.getPlayer(fid);
  const name      = player?.name || '?';
  const initials  = name.split(/\s+/).map(w => w[0]?.toUpperCase() || '').join('').slice(0, 2);
  const positions = fieldingPositions(g) || {};
  const pos       = positions[fid] || '?';
  const team      = State.teams.find(t => (t.playerIds || []).includes(fid));
  const teamColor = team ? _teamColor(team) : '#6b7280';
  let startSvg;
  if (pos === 'P')  startSvg = FIELD.MOUND;
  else if (pos === 'CF') startSvg = FIELD.CF_HOME;
  else startSvg = FIELD.SECOND; // fallback for any other position
  return { pid: fid, initials, name, pos, teamColor, startSvg };
}

function _unfreezeDisplay() {
  _frozenScore     = null;
  _frozenOuts      = null;
  _frozenBases     = null;
  _betweenInnings  = false;
  _frozenCount     = null;
  _frozenBatterId  = null;
  _frozenPitcherId = null;
  _frozenHalf      = null;
  _frozenInning    = null;
  _animInputLocked = false;
  if (LiveGameId) renderLiveGame(LiveGameId, LiveGameWatchOnly);
}

function _runAnim(item) {
  // Only show animations when the user is on the Score tab
  if (_liveTab !== 'score') { _nextAnim(); return; }

  // Blank hold: timed pause with no visual output (used between innings)
  if (item.blank) {
    const myGen = _animGen;
    setTimeout(() => { if (_animGen === myGen) _nextAnim(); }, item.holdMs ?? 3000);
    return;
  }

  const overlay    = document.getElementById('play-anim-overlay');
  const ballEl     = document.getElementById('anim-ball');
  const fielderEl  = document.getElementById('anim-fielder');
  const bannerEl   = document.getElementById('anim-banner');
  if (!overlay || !ballEl || !bannerEl) { _nextAnim(); return; }

  const myGen = _animGen;   // capture generation — if _cancelAnim fires, myGen != _animGen
  const alive = () => _animGen === myGen;  // guard for stale callbacks

  const holdMs = item.holdMs ?? (item.big ? 1600 : 1200);
  const fadeMs = 300;

  // ── Banner text (no SVG coords needed yet) ───────────────────
  bannerEl.innerHTML        = item.text;
  bannerEl.style.color      = item.color || '#fff';
  bannerEl.style.fontSize   = item.big ? '34px' : '24px';
  bannerEl.style.opacity    = '0';
  bannerEl.style.transition = 'none';
  bannerEl.style.transform  = 'translate(-50%, -50%) scale(0.8)';
  ballEl.style.display      = 'none';
  if (fielderEl) {
    fielderEl.style.display    = 'none';
    fielderEl.style.transition = 'none';
    if (item.fielderInfo) {
      const fi = item.fielderInfo;
      fielderEl.innerHTML = `
        <circle cx="0" cy="0" r="16" style="fill:${fi.teamColor};fill-opacity:0.85;stroke:rgba(255,255,255,0.85);stroke-width:1.5"/>
        <text x="0" y="1" text-anchor="middle" dominant-baseline="middle"
              style="font-size:10px;font-weight:800;fill:#fff;font-family:inherit;pointer-events:none">${escapeHtml(fi.pos)}</text>
        <text x="0" y="26" text-anchor="middle"
              style="font-size:9px;font-weight:700;fill:#000;stroke:#fff;stroke-width:3;paint-order:stroke fill;font-family:inherit;pointer-events:none">${escapeHtml(fi.name)}</text>`;
    } else {
      fielderEl.innerHTML = '';
    }
  }
  overlay.style.display     = 'block';

  // Defer ALL coordinate lookups to the next animation frame.
  // This ensures we query the FRESH #field-svg that renderLiveGame()
  // rebuilds synchronously after _runAnim is called.
  // Fallback: requestAnimationFrame is throttled in background tabs, so a
  // setTimeout(50) ensures the animation proceeds even if rAF never fires.
  let _rafStarted = false;
  const _rafBody = () => {
    if (_rafStarted || !alive()) return;
    _rafStarted = true;
    if (!alive()) return;   // cancelled before first frame
    const svgEl  = document.getElementById('field-svg');
    const ctm    = svgEl ? svgEl.getScreenCTM() : null;
    const hasBall = !!(ctm && item.fromSvg && item.toSvg);

    // SVG user-space (0-400) → screen pixels using the live CTM
    const sc = (sx, sy) => {
      const pt = svgEl.createSVGPoint();
      pt.x = sx; pt.y = sy;
      const s = pt.matrixTransform(ctm);
      return { x: s.x, y: s.y };
    };

    let ballFlightMs = 0;

    if (hasBall) {
      const from = sc(item.fromSvg.x, item.fromSvg.y);

      // Place ball at starting position (11px = half of 22px flex container for exact centering)
      ballEl.style.cssText = `
        position:absolute; font-size:18px;
        display:flex; align-items:center; justify-content:center;
        width:22px; height:22px;
        will-change:transform; filter:drop-shadow(0 2px 4px rgba(0,0,0,.4));
        left:${from.x - 11}px; top:${from.y - 11}px;
        transform:translate(0,0) scale(1); transition:none; opacity:1;`;

      // Pre-compute all destination offsets (relative to `from`)
      if (item.viaSvg) {
        const p1Dur = item.phase1Dur || 380;
        const p2Dur = item.phase2Dur || 340;
        ballFlightMs = p1Dur + p2Dur;
        const via = sc(item.viaSvg.x, item.viaSvg.y);
        const to  = sc(item.toSvg.x,  item.toSvg.y);
        const dx1 = via.x - from.x, dy1 = via.y - from.y;
        const dx2 = to.x  - from.x, dy2 = to.y  - from.y;
        requestAnimationFrame(() => {
          if (!alive()) return;
          ballEl.style.transition = `transform ${p1Dur}ms ease-in`;
          ballEl.style.transform  = `translate(${dx1}px,${dy1}px) scale(0.85)`;
          setTimeout(() => {
            if (!alive()) return;
            ballEl.style.transition = `transform ${p2Dur}ms ease-out`;
            ballEl.style.transform  = `translate(${dx2}px,${dy2}px) scale(0.7)`;
          }, p1Dur);
        });
      } else {
        const ballDur = item.ballDur || 650;
        ballFlightMs  = ballDur;
        const to  = sc(item.toSvg.x, item.toSvg.y);
        const dx  = to.x - from.x, dy = to.y - from.y;
        requestAnimationFrame(() => {
          if (!alive()) return;
          ballEl.style.transition = `transform ${ballDur}ms ease-in, opacity 0.25s`;
          ballEl.style.transform  = `translate(${dx}px,${dy}px) scale(0.7)`;
        });
      }
    }

    // ── Fielder animation (OUT / ERR_REACH) ───────────────────
    // Fielder starts at their position, then sprints to the play location
    // at the same moment the ball leaves the plate (phase1Dur into the anim).
    if (fielderEl && ctm && item.fielderInfo && item.toSvg) {
      const fi      = item.fielderInfo;
      const fStart  = sc(fi.startSvg.x, fi.startSvg.y);
      const fEnd    = sc(item.toSvg.x,  item.toSvg.y);
      const runDur  = item.phase2Dur || 450; // match ball phase-2 duration
      const startDelay = item.viaSvg ? (item.phase1Dur || 350) : 0;

      // Suppress this fielder's static circle in drawField() for the duration of the animation.
      // Call drawField() immediately so the static SVG circle is removed before the
      // animated one starts moving — without this, watchers see two circles.
      _animFielderPid = fi.pid;
      drawField();

      // Place fielder SVG at start position (viewBox is -30 -30 60 60, so circle centre = top-left corner)
      fielderEl.style.cssText = `
        display:block; position:absolute;
        width:60px; height:60px; overflow:visible;
        will-change:transform;
        filter:drop-shadow(0 2px 4px rgba(0,0,0,0.4));
        left:${fStart.x - 30}px; top:${fStart.y - 30}px;
        transform:translate(0,0); transition:none; opacity:1;`;

      const dx = fEnd.x - fStart.x, dy = fEnd.y - fStart.y;
      setTimeout(() => {
        if (!alive()) return;
        requestAnimationFrame(() => {
          if (!alive()) return;
          fielderEl.style.transition = `transform ${runDur}ms ease-out`;
          fielderEl.style.transform  = `translate(${dx}px,${dy}px)`;
        });
      }, startDelay);
    }

    // ── Banner appears when ball arrives ──────────────────────
    setTimeout(() => {
      if (!alive()) return;
      // Fire onBannerShow callback at the exact moment the banner becomes visible.
      // Used to update count/score/state displays in sync with the toast appearance.
      if (item.onBannerShow) item.onBannerShow();
      bannerEl.style.transition = 'opacity 0.2s ease-out, transform 0.2s ease-out';
      bannerEl.style.opacity    = '1';
      bannerEl.style.transform  = 'translate(-50%, -50%) scale(1)';
    }, ballFlightMs);

    // ── Fade everything out ───────────────────────────────────
    const totalVisible = ballFlightMs + holdMs;
    setTimeout(() => {
      if (!alive()) return;
      ballEl.style.transition     = `opacity ${fadeMs}ms`;
      ballEl.style.opacity        = '0';
      bannerEl.style.transition   = `opacity ${fadeMs}ms`;
      bannerEl.style.opacity      = '0';
      if (fielderEl) {
        fielderEl.style.transition = `opacity ${fadeMs}ms`;
        fielderEl.style.opacity    = '0';
      }
      // Un-suppress the static fielder circle as the animated one fades
      // Also release the spray chart lock so it switches to the new batter
      _animFielderPid  = null;
      _sprayBatterId   = null;
      _sprayCachedDots = null;
      drawField();
    }, totalVisible);

    // ── Done — advance queue ──────────────────────────────────
    setTimeout(() => {
      if (!alive()) return;
      overlay.style.display = 'none';
      _nextAnim();
    }, totalVisible + fadeMs + 50);
  };
  requestAnimationFrame(_rafBody);
  setTimeout(_rafBody, 50); // fallback: rAF is throttled in background/inactive tabs
}

function _detectAndQueueAnims(newG, prev) {
  if (!newG || !prev) return;
  const events       = newG.events || [];
  const hasNewEvents = events.length > prev.eventsLen;
  const gameJustFinished = newG.status === 'completed' && prev.status !== 'completed';
  const inningChanged    = newG.currentInning !== prev.currentInning ||
                           newG.currentHalf   !== prev.currentHalf;

  // ── 1. New plate-appearance outcomes ────────────────────────
  if (hasNewEvents) {
    let frozeDisplay = false;
    events.slice(prev.eventsLen).forEach(ev => {
      if (ev.type !== 'pa_end') return;
      const anim = _buildOutcomeAnim(ev, newG);
      if (anim) {
        if (!frozeDisplay) {
          // Freeze PRE-play score/outs/bases during the toast — reveals POST-play
          // after toast dismisses, matching scorer-path behaviour.
          _frozenScore     = { ...prev.score };
          _frozenOuts      = prev.outs;
          _frozenBases     = JSON.parse(JSON.stringify(prev.bases || {}));
          // During ball flight: show PRE-pitch count (snapshot before this PA)
          _frozenCount     = { balls: prev.balls, strikes: prev.strikes, fouls: prev.fouls };
          _frozenBatterId  = prev.batterId  || null;
          _frozenPitcherId = prev.pitcherId || null;
          // Freeze half/inning so the scoreboard and fielder circles stay on the old
          // inning until the blank-field fn releases them (same as scorer path).
          _frozenHalf      = prev.currentHalf;
          _frozenInning    = prev.currentInning;
          frozeDisplay = true;
        }
        // At the moment the banner appears: snap count to FINAL value (stored in event)
        const finalCount = { balls: ev.countBalls ?? 0, strikes: ev.countStrikes ?? 0, fouls: ev.countFouls ?? 0 };
        anim.onBannerShow = () => {
          _frozenCount = finalCount;
          if (LiveGameId) renderLiveGame(LiveGameId, true);
        };
        _queueAnim(anim);
      }
    });
    // If we froze AND there's no inning/game change, unfreeze after outcome anims.
    // Guard against the race where a second snapshot (inning advance) arrives before
    // the unfreezeDisplay fn fires — if the inning has already changed, skip the
    // unfreeze and let the inning-change handler manage the transition instead.
    if (frozeDisplay && !inningChanged && !gameJustFinished) {
      const expectedInning = newG.currentInning;
      const expectedHalf   = newG.currentHalf;
      _queueAnim({ fn: () => {
        const g = State.getGame(LiveGameId);
        if (g && (g.currentInning !== expectedInning || g.currentHalf !== expectedHalf)) return;
        _unfreezeDisplay();
      }});
    }
    // fall through — same Firestore push may also contain inning/status change
  }

  // ── 2. Game finished ────────────────────────────────────────
  if (gameJustFinished) {
    const prevHalf = prev.currentHalf === 'top' ? 'Top' : 'Bottom';
    _queueAnim({ text: `End of ${prevHalf} ${ordinal(prev.currentInning)}`, color: '#60a5fa', holdMs: 1400 });
    const away   = State.getTeam(newG.awayTeamId);
    const home   = State.getTeam(newG.homeTeamId);
    const winner = newG.score.away > newG.score.home ? away
                 : newG.score.home > newG.score.away ? home : null;
    _queueAnim({
      text: winner ? `${winner.name} win! 🏆` : "It's a tie! 🏁",
      color: '#fde68a', big: true, holdMs: 2400,
    });
    return; // skip inning / pitcher checks — game is over
  }

  // ── 3. Inning / half change ──────────────────────────────────
  if (inningChanged) {
    const prevHalf = prev.currentHalf === 'top' ? 'Top' : 'Bottom';
    // Determine the 3rd out value: prefer outsAfter from the last new event (robust
    // whether the K-save and inning-advance arrive as one snapshot or two).
    const newEventsSlice = events.slice(prev.eventsLen);
    const lastNewEv = newEventsSlice[newEventsSlice.length - 1];
    const endOuts = (lastNewEv && lastNewEv.outsAfter !== undefined) ? lastNewEv.outsAfter : prev.outs;

    // Before EOI banner: clear count only; keep batter/pitcher/half/inning/outs frozen
    // so the display still shows old inning's players and 3rd out pip.
    _queueAnim({ fn: () => {
      _frozenCount     = null;
      // _frozenBatterId  stays set — old batter stays visible during EOI
      // _frozenPitcherId stays set — old pitcher stays visible during EOI
      _frozenOuts      = endOuts;  // show 3rd out during EOI banner
      // _frozenHalf/_frozenInning stay set — keep old inning display and fielders
      // _betweenInnings stays false — fielders from this inning remain visible
      if (LiveGameId) renderLiveGame(LiveGameId, true);
    }});
    // EOI banner: outs=3 shown, old inning fielders/batter/pitcher still visible
    _queueAnim({ text: `End of ${prevHalf} ${ordinal(prev.currentInning)}`, color: '#60a5fa', holdMs: 1400 });
    // After EOI banner: blank field, clear all frozen state, release half/inning freeze
    _queueAnim({ fn: () => {
      _frozenCount     = null;
      _frozenBatterId  = null;
      _frozenPitcherId = null;
      _frozenScore     = null;
      _frozenOuts      = null;
      _frozenBases     = null;
      _frozenHalf      = null;
      _frozenInning    = null;
      _betweenInnings  = true;
      if (LiveGameId) renderLiveGame(LiveGameId, true);
    }});
    _queueAnim({ blank: true, holdMs: 2000 });
    const halfLabel = newG.currentHalf === 'top' ? '▲ Top' : '▼ Bottom';
    // At the moment the start-of-inning banner appears, reveal new inning fielders
    _queueAnim({
      text: `${halfLabel} of the ${ordinal(newG.currentInning)}`,
      color: '#60a5fa', holdMs: 1800,
      onBannerShow: () => {
        _betweenInnings = false;
        if (LiveGameId) renderLiveGame(LiveGameId, true);
      }
    });
    _queueAnim({ fn: _unfreezeDisplay });
    return; // pitcher swap after an inning flip is expected — don't fire that too
  }

  // ── 4. Mid-inning pitcher change (no new events, same half) ──
  if (!hasNewEvents) {
    const newPositions = fieldingPositions(newG) || {};
    const newPid = Object.keys(newPositions).find(pid => newPositions[pid] === 'P') || null;
    if (newPid && newPid !== prev.pitcherId) {
      const pitcher = State.getPlayer(newPid);
      _queueAnim({ text: `${pitcher?.name || '?'} is now pitching`, color: '#a78bfa', holdMs: 2500 });
    }
  }

  // ── 5. Pitch-count changes (ball / strike / foul) ────────────
  // Only fires when there are no new pa_end events (counts reset to 0 on each PA end).
  // For each pitch: freeze to PRE-pitch count during ball flight, then update to POST-pitch
  // count at the exact moment the banner appears — matching scorer-path behaviour.
  if (!hasNewEvents) {
    // A foul with < 2 strikes increments BOTH fouls and strikes — subtract the
    // foul-caused bump so we don't fire a duplicate Strike animation.
    const dFouls   = (newG.fouls   || 0) - prev.fouls;
    const rawDS    = (newG.strikes || 0) - prev.strikes;
    const dStrikes = Math.max(0, rawDS - dFouls);  // pure strike presses only
    const dBalls   = (newG.balls   || 0) - prev.balls;

    for (let i = 0; i < dBalls; i++) {
      const beforeCount = { balls: prev.balls + i,     strikes: prev.strikes, fouls: prev.fouls };
      const afterCount  = { balls: prev.balls + i + 1, strikes: prev.strikes, fouls: prev.fouls };
      _queueAnim({ fn: () => { _frozenCount = beforeCount; if (LiveGameId) renderLiveGame(LiveGameId, true); } });
      _queueAnim({ text: 'Ball', color: '#fbbf24', fromSvg: FIELD.MOUND, toSvg: { x: 200, y: 368 },
        onBannerShow: () => { _frozenCount = afterCount; if (LiveGameId) renderLiveGame(LiveGameId, true); }
      });
    }
    if (dBalls > 0) _queueAnim({ fn: () => { _frozenCount = null; } });

    for (let i = 0; i < dStrikes; i++) {
      const beforeCount = { balls: prev.balls, strikes: prev.strikes + i,     fouls: prev.fouls };
      const afterCount  = { balls: prev.balls, strikes: prev.strikes + i + 1, fouls: prev.fouls };
      _queueAnim({ fn: () => { _frozenCount = beforeCount; if (LiveGameId) renderLiveGame(LiveGameId, true); } });
      _queueAnim({ text: 'Strike ⚡', color: '#f87171', fromSvg: FIELD.MOUND, toSvg: FIELD.HOME,
        onBannerShow: () => { _frozenCount = afterCount; if (LiveGameId) renderLiveGame(LiveGameId, true); }
      });
    }
    if (dStrikes > 0) _queueAnim({ fn: () => { _frozenCount = null; } });

    for (let i = 0; i < dFouls; i++) {
      const goRight = Math.random() < 0.5;
      const beforeCount = { balls: prev.balls, strikes: prev.strikes,  fouls: prev.fouls + i };
      // After the foul, strikes may bump if prev.strikes < 2; use newG.strikes for accuracy.
      // (dFouls>1 is extremely rare, so newG.strikes as final value is fine for the sequence.)
      const afterCount  = { balls: prev.balls, strikes: newG.strikes,  fouls: prev.fouls + i + 1 };
      _queueAnim({ fn: () => { _frozenCount = beforeCount; if (LiveGameId) renderLiveGame(LiveGameId, true); } });
      _queueAnim({
        text: 'Foul!', color: '#fb923c',
        fromSvg:  FIELD.MOUND,
        viaSvg:   FIELD.HOME,
        toSvg:    goRight ? { x: 338, y: 352 } : { x: 62, y: 352 },
        phase1Dur: 380, phase2Dur: 340,
        onBannerShow: () => { _frozenCount = afterCount; if (LiveGameId) renderLiveGame(LiveGameId, true); }
      });
    }
    if (dFouls > 0) _queueAnim({ fn: () => { _frozenCount = null; } });
  }
}

function _buildOutcomeAnim(ev, g) {
  const raw = ev.location; // {x,y} in 0-400 SVG space, or null
  // Small random jitter makes the ball feel organic and masks minor coord drift
  const j  = () => (Math.random() - 0.5) * 14;
  const loc = raw ? { x: raw.x + j(), y: raw.y + j() } : null;

  // All balls-in-play: pitch travels mound→plate first, then out to the field
  switch (ev.outcome) {
    case 'BB':  return { text: 'Walk! 🥊',      color: '#4ade80',
                         fromSvg: FIELD.MOUND,  toSvg: { x: 200, y: 368 } };
    case 'K':   return { text: 'Strikeout! 🔥',
                         color: '#f87171', fromSvg: FIELD.MOUND, toSvg: FIELD.HOME };
    case 'FO':  return { text: 'Foul Out! 🔥',
                         color: '#f87171', fromSvg: FIELD.MOUND, toSvg: FIELD.HOME };
    case '1B':  return { text: 'Single! 🎯',    color: '#4ade80',
                         fromSvg: FIELD.MOUND,  viaSvg: FIELD.HOME,
                         toSvg: loc || FIELD.FIRST,  phase1Dur: 350, phase2Dur: 450 };
    case '2B':  return { text: 'Double! 💥',    color: '#4ade80',
                         fromSvg: FIELD.MOUND,  viaSvg: FIELD.HOME,
                         toSvg: loc || FIELD.SECOND, phase1Dur: 350, phase2Dur: 520 };
    case '3B':  return { text: 'Triple! 🚀',    color: '#67e8f9',
                         fromSvg: FIELD.MOUND,  viaSvg: FIELD.HOME,
                         toSvg: loc || FIELD.THIRD,  phase1Dur: 350, phase2Dur: 520 };
    case 'HR':  return { text: 'HOME RUN! 🎆',  color: '#fde68a', big: true,
                         fromSvg: FIELD.MOUND,  viaSvg: FIELD.HOME,
                         toSvg: loc || { x: 200, y: 18 }, phase1Dur: 350, phase2Dur: 920 };
    case 'OUT': {
      const dest = loc || FIELD.SECOND;
      let outText  = 'Out!';
      let outColor = '#fb923c';
      let outBig   = false;
      if (ev.doublePlay) {
        outText  = 'Double Play! ⚡';
        outColor = '#fde68a';
        outBig   = true;
      } else if (ev.dpAttempted) {
        outText  = 'Runner Safe — No DP';
        outColor = '#fb923c';
      } else if (ev.sacFly && !ev.sacFlyOut) {
        outText  = 'Tag Up — Runner Scores! 🏃';
        outColor = '#4ade80';
      } else if (ev.sacFly && ev.sacFlyOut) {
        outText  = 'Tag Play — Out! ✋';
        outColor = '#fb923c';
      }
      return { text: outText, color: outColor, big: outBig,
               fromSvg: FIELD.MOUND, viaSvg: FIELD.HOME,
               toSvg: dest, phase1Dur: 350, phase2Dur: 450,
               fielderInfo: _getFielderInfo(ev.fielderId, g) };
    }
    case 'ERR_REACH': {
      const dest = loc || FIELD.SECOND;
      return { text: 'Error! 😬', color: '#c084fc',
               fromSvg: FIELD.MOUND, viaSvg: FIELD.HOME,
               toSvg: dest, phase1Dur: 350, phase2Dur: 450,
               fielderInfo: _getFielderInfo(ev.errorById, g) };
    }
    default: return null;
  }
}

let __fieldClickMode = null;
let __bipStep = null;
let __bipKind = null;
let __bipDetail = null;

function toggleSprayChart() {
  _sprayChartVisible = !_sprayChartVisible;
  drawField();
  const keyEl = document.getElementById('spray-chart-key');
  const btnEl = document.getElementById('spray-toggle-btn');
  if (keyEl) keyEl.style.visibility = _sprayChartVisible ? 'visible' : 'hidden';
  if (btnEl) btnEl.classList.toggle('active', _sprayChartVisible);
}

function getSprayData(playerId) {
  const results = [];
  for (const g of State.games) {
    for (const e of (g.events || [])) {
      if (e.type !== 'pa_end' || e.batterId !== playerId || !e.location) continue;
      // Errors are grouped with outs on the chart
      let displayOutcome = e.outcome === 'ERR_REACH' ? 'OUT' : e.outcome;
      // Skip triples — not shown on spray chart
      if (displayOutcome === '3B') continue;
      results.push({ x: e.location.x, y: e.location.y, outcome: displayOutcome });
    }
  }
  return results.slice(-50);
}

function drawField(overrideBases = null) {
  const g = State.getGame(LiveGameId);
  if (!g) return;
  const container = $('#field-container');
  if (!container) return;

  const isCompleted = g.status === 'completed';
  const bases = overrideBases !== null ? overrideBases
              : _frozenBases  !== null ? _frozenBases
              : isCompleted            ? { 1: null, 2: null, 3: null }
              : g.bases;

  // Use frozen half during outcome/EOI animations so fielder positions don't flip to the
  // new inning the moment endHalfInningInternal saves to Firestore.
  const displayHalf  = _frozenHalf ?? g.currentHalf;
  const displayG     = displayHalf !== g.currentHalf ? { ...g, currentHalf: displayHalf } : g;
  const fieldingPos  = _betweenInnings ? {} : fieldingPositions(displayG);
  const pitcherId = Object.keys(fieldingPos).find(pid => fieldingPos[pid] === 'P');
  const cfId = Object.keys(fieldingPos).find(pid => fieldingPos[pid] === 'CF');
  const pitcher = pitcherId ? State.getPlayer(pitcherId) : null;
  const cf = cfId ? State.getPlayer(cfId) : null;
  const batterId = (isCompleted || _betweenInnings) ? null : (_frozenBatterId || currentBatterId(g));
  const batter = batterId ? State.getPlayer(batterId) : null;

  // Team colors for fielder/batter circles (use display half)
  const fielderFill = _teamColor(State.getTeam(fieldingTeamId(displayG)));
  const batterFill  = _teamColor(State.getTeam(battingTeamId(displayG)));

  const fielderMarker = (pid, player, pos, cx, cy, fillColor, hidden = false) => {
    if (hidden) return '';
    // No player assigned: show a dashed placeholder that can be tapped to assign one
    if (!player) {
      const canScoreNow = !LiveGameWatchOnly && canUserScore() && !isCompleted;
      if (!canScoreNow) return '';
      return `<g class="fielder" data-pid="" data-pos="${pos}" transform="translate(${cx},${cy})" style="cursor:pointer">
        <circle cx="0" cy="0" r="16" style="fill:#f3f4f6;stroke:#9ca3af;stroke-width:1.5;stroke-dasharray:4,3"/>
        <text class="pos" x="0" y="0" style="fill:#9ca3af">${pos}</text>
        <text class="name bg" y="26" style="fill:#9ca3af">?</text>
        <text class="name" y="26" style="fill:#9ca3af">?</text>
      </g>`;
    }
    const gloveMode = __fieldClickMode && __fieldClickMode.needFielder;
    if (gloveMode) {
      // Out/error drag mode: glove image only, no circle.
      // A transparent rect covers the full marker area so pointer events register
      // even though the <image> itself has pointer-events:none.
      const sz = 28, h = sz / 2;
      return `<g class="fielder" data-pid="${pid}" data-pos="${pos}" transform="translate(${cx},${cy})">
        <rect x="${-h}" y="${-h}" width="${sz}" height="${sz + 20}" fill="transparent" style="pointer-events:all"/>
        <image href="glove.png" x="${-h}" y="${-h}" width="${sz}" height="${sz}" style="pointer-events:none"/>
        <text class="name bg" y="${h + 8}">${escapeHtml(player.name)}</text>
        <text class="name" y="${h + 8}">${escapeHtml(player.name)}</text>
      </g>`;
    } else {
      // Normal mode: simple circle + position label + name
      return `<g class="fielder" data-pid="${pid}" data-pos="${pos}" transform="translate(${cx},${cy})">
        <circle class="fielder-circle" cx="0" cy="0" r="16" style="fill:${fillColor};fill-opacity:0.85"/>
        <text class="pos" x="0" y="0">${pos}</text>
        <text class="name bg" y="26">${escapeHtml(player.name)}</text>
        <text class="name" y="26">${escapeHtml(player.name)}</text>
      </g>`;
    }
  };

  // Match Field.svg base proportions: ~4.6 wide × ~6.9 tall in 400×400 space
  const sx = 6, sy = 9;
  const sq = (cx, cy, runner) => {
    if (!runner) return '';
    const ini = playerInitials(runner.playerId);
    const tagW = Math.max(18, ini.length * 6 + 8);
    return `
      <polygon class="base occupied" points="${cx},${cy-sy} ${cx+sx},${cy} ${cx},${cy+sy} ${cx-sx},${cy}" />
      <g class="runner-tag" transform="translate(${cx},${cy - sy - 9})">
        <rect x="${-tagW/2}" y="-7" width="${tagW}" height="13" rx="3"/>
        <text x="0" y="3">${ini}</text>
      </g>`
  };

  // Spray chart dots + legend
  const SPRAY_COLORS = { '1B': '#4ade80', '2B': '#60a5fa', 'HR': '#fde68a', 'OUT': '#fb923c' };
  const sprayLayer = (() => {
    if (!_sprayChartVisible) return '';
    // During animation: use cached snapshot (excludes the just-recorded hit) for the
    // locked batter. After animation: live data for the current batter.
    const sprayPid = _sprayBatterId || batterId;
    if (!sprayPid) return '';
    const dots = (_sprayCachedDots !== null ? _sprayCachedDots : getSprayData(sprayPid)).map(d => {
      const color = SPRAY_COLORS[d.outcome] || '#94a3b8';
      return `<circle cx="${d.x}" cy="${d.y}" r="5" fill="${color}" fill-opacity="0.7" stroke="#fff" stroke-width="1" stroke-opacity="0.6" pointer-events="none"/>`;
    }).join('');
    return dots;
  })();

  // Update the HTML instruction bar above the field (replaces old SVG overlay)
  const instrText = __bipStep === 'locate'
    ? (__bipKind === 'out'   ? 'Drag fielder to where the play happened'
     : __bipKind === 'error' ? 'Drag fielder to where the error happened'
     : __bipKind === 'hr'    ? 'Tap where the ball left the field'
     :                         'Tap where the ball landed')
    : '';
  const instrEl = document.getElementById('bip-instruction');
  if (instrEl) {
    instrEl.hidden = !instrText;
    const txtEl = instrEl.querySelector('.bip-instruction-text');
    if (txtEl) txtEl.textContent = instrText;
  }

  const svg = `
    <svg viewBox="0 0 400 400" class="field-svg" id="field-svg">
      <!-- White background visible outside/below the field cone -->
      <rect x="0" y="0" width="400" height="400" fill="#ffffff"/>
      <!-- Field.svg stretched to fill — provides all field visuals (grass, dirt,
           foul lines, arcs, bases, home plate, batter's boxes, pitcher's rubber) -->
      <image href="Field.svg" x="0" y="0" width="400" height="400" preserveAspectRatio="none"/>
      <!-- Occupied base highlights (yellow overlay, aligned to Field.svg base centres) -->
      ${sq(FIELD.FIRST.x,  FIELD.FIRST.y,  bases && bases[1])}
      ${sq(FIELD.SECOND.x, FIELD.SECOND.y, bases && bases[2])}
      ${sq(FIELD.THIRD.x,  FIELD.THIRD.y,  bases && bases[3])}
      <!-- Fielder markers (hidden between innings so the field is blank) -->
      ${(isCompleted || _betweenInnings) ? '' : fielderMarker(pitcherId, pitcher, 'P',  FIELD.MOUND.x,   FIELD.MOUND.y,   fielderFill, pitcherId === _animFielderPid)}
      ${(isCompleted || _betweenInnings) ? '' : fielderMarker(cfId,      cf,      'CF', FIELD.CF_HOME.x, FIELD.CF_HOME.y, fielderFill, cfId      === _animFielderPid)}
      <!-- Batter marker (team color circle, just below home plate) -->
      ${batter ? (() => {
        const canScoreNow = !LiveGameWatchOnly && canUserScore() && !__bipStep;
        const gAttrs = canScoreNow
          ? `class="batter-marker batter-marker--clickable" onclick="showSkipBatterModal()" style="cursor:pointer"`
          : `class="batter-marker"`;
        return `<g ${gAttrs} transform="translate(${FIELD.HOME.x},${FIELD.HOME.y + 26})">
          <circle class="batter-circle" cx="0" cy="0" r="14" style="fill:${batterFill};fill-opacity:0.85"/>
          <text class="pos" x="0" y="0">🏏</text>
          <text class="name bg" y="22">${escapeHtml(batter.name)}</text>
          <text class="name"    y="22">${escapeHtml(batter.name)}</text>
        </g>`;
      })() : ''}
      <!-- Spray chart BIP dots + legend -->
      ${sprayLayer}
    </svg>
  `;
  container.innerHTML = svg;

  const svgEl = $('#field-svg');
  attachSvgLocationHandlers(svgEl);

  if (__bipStep === 'locate' && svgEl) {
    svgEl.classList.add('location-mode');
  }
}

function drawBases(overrideBases = null) {
  drawField(overrideBases);
}

function svgPoint(svg, evt) {
  const pt = svg.createSVGPoint();
  const src = (evt.changedTouches || evt.touches)?.[0] || evt;
  pt.x = src.clientX;
  pt.y = src.clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}

function attachSvgLocationHandlers(svgEl) {
  const DRAG_THRESHOLD = 8;
  let pointerStart = null; // { x, y, fielderId, fielderEl }

  const getPoint = (e) => {
    const pt = svgPoint(svgEl, e);
    return { x: Math.round(pt.x), y: Math.round(pt.y) };
  };

  const onStart = (e) => {
    const fielderEl = e.target.closest('.fielder');
    const pt = svgPoint(svgEl, e);
    let origX = 0, origY = 0;
    if (fielderEl) {
      const m = (fielderEl.getAttribute('transform') || '').match(/translate\(([^,]+),([^)]+)\)/);
      if (m) { origX = parseFloat(m[1]); origY = parseFloat(m[2]); }
    }
    pointerStart = { x: pt.x, y: pt.y, fielderId: fielderEl?.dataset.pid || null, fielderEl, origX, origY };
    if (__fieldClickMode) e.preventDefault();
  };

  const onMove = (e) => {
    if (!pointerStart || !__fieldClickMode) return;
    e.preventDefault();
    const pt = svgPoint(svgEl, e);
    const dist = Math.hypot(pt.x - pointerStart.x, pt.y - pointerStart.y);
    if (dist > DRAG_THRESHOLD) {
      if (pointerStart.fielderEl && __fieldClickMode.needFielder) {
        // Out / error: drag the fielder element to the play location
        pointerStart.fielderEl.setAttribute('transform', `translate(${Math.round(pt.x)},${Math.round(pt.y)})`);
      } else if (!__fieldClickMode.needFielder) {
        // Hit / HR: show ball marker while dragging (fielders stay put)
        drawBallMarker({ x: Math.round(pt.x), y: Math.round(pt.y) });
      }
    }
  };

  const onEnd = (e) => {
    if (!pointerStart) return;
    const start = pointerStart;
    pointerStart = null;

    // Snap fielder back to original position
    if (start.fielderEl) {
      start.fielderEl.setAttribute('transform', `translate(${start.origX},${start.origY})`);
    }

    const pt = svgPoint(svgEl, e);
    const loc = { x: Math.round(pt.x), y: Math.round(pt.y) };
    const isDrag = Math.hypot(pt.x - start.x, pt.y - start.y) > DRAG_THRESHOLD;

    if (__fieldClickMode) {
      e.preventDefault();
      if (__fieldClickMode.needFielder) {
        // Out / error: must drag from a fielder marker
        if (start.fielderId && isDrag) {
          __fieldClickMode.onDragEnd(start.fielderId, loc);
        }
      } else {
        // Hit / HR: any tap or drag on the field works
        drawBallMarker(loc);
        __fieldClickMode.onDragEnd(null, loc);
      }
    } else {
      // Not in BIP mode — short tap on a fielder opens the swap/assign modal
      // Also fires for placeholder markers where fielderId is '' (empty position)
      if (!isDrag && start.fielderEl) {
        e.preventDefault(); // suppress synthetic click that would immediately close the modal
        onFielderClick(start.fielderId || '', start.fielderEl?.dataset.pos || '');
      }
    }
  };

  svgEl.addEventListener('mousedown', onStart);
  svgEl.addEventListener('mousemove', onMove);
  svgEl.addEventListener('mouseup', onEnd);
  svgEl.addEventListener('touchstart', onStart, { passive: false });
  svgEl.addEventListener('touchmove', onMove, { passive: false });
  svgEl.addEventListener('touchend', onEnd, { passive: false });
}

function onFielderClick(pid, pos) {
  if (__fieldClickMode && __fieldClickMode.onPickFielder) {
    if (pid) __fieldClickMode.onPickFielder(pid);
    return;
  }
  if (!pid) {
    // Placeholder tapped — show an assignment modal to fill the empty position
    showAssignPositionModal(pos);
    return;
  }
  showSwapFielderModal(pid, pos);
}

function showAssignPositionModal(pos) {
  const g = State.getGame(LiveGameId); if (!g) return;
  const team = State.getTeam(fieldingTeamId(g));
  if (!team) return;
  const positions = fieldingPositions(g);
  const label = pos === 'P' ? 'Pitcher' : 'Center Fielder';

  const list = (team.playerIds || []).map(pid => {
    const p = State.getPlayer(pid);
    const curPos = positions[pid] || 'BENCH';
    return `<button class="btn" style="display:flex;justify-content:space-between;width:100%;margin-bottom:6px"
        onclick="assignPositionFromModal('${pid}','${pos}')">
      <span>${escapeHtml(p?.name || '?')}</span>
      <span class="pill">${curPos}</span>
    </button>`;
  }).join('');

  Modal.show(`
    <div class="modal-header">
      <h3>Assign ${label}</h3>
      <button class="btn-icon" onclick="Modal.hide(); renderLiveGame('${g.id}')">✕</button>
    </div>
    <div class="modal-body">
      <p class="help-text" style="margin-bottom:10px">Pick a player to fill the ${label} position. Their current position will be swapped.</p>
      ${list || '<div class="muted">No players available.</div>'}
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="Modal.hide(); renderLiveGame('${g.id}')">Cancel</button>
    </div>
  `);
}

async function assignPositionFromModal(newPid, pos) {
  const g = State.getGame(LiveGameId); if (!g) return;
  const positions = { ...(g.currentHalf === 'top' ? g.homePositions : g.awayPositions) };
  const newOldPos = positions[newPid] || 'BENCH';
  positions[newPid] = pos;
  // The old holder of this position (if any) gets the incoming player's old spot
  Object.keys(positions).forEach(pid => {
    if (pid !== newPid && positions[pid] === pos) positions[pid] = newOldPos;
  });
  const posKey = g.currentHalf === 'top' ? 'homePositions' : 'awayPositions';
  await State.updateGame(g.id, { [posKey]: positions });
  Modal.hide();
  renderLiveGame(g.id);
  toast(`${State.getPlayer(newPid)?.name || '?'} assigned to ${pos}`, 'success');
}

/* ----- Swap fielder positions ----- */
function showSwapFielderModal(currentPid, currentPos) {
  const g = State.getGame(LiveGameId); if (!g) return;
  const positions = fieldingPositions(g);
  const team = State.getTeam(fieldingTeamId(g));
  const others = team.playerIds.filter(pid => pid !== currentPid);
  const cur = State.getPlayer(currentPid);

  // Always get the real batters-faced count so we can warn even when the
  // pitcher is the *target* of a non-pitcher swap (e.g. CF ↔ P).
  const fieldingSide = g.currentHalf === 'top' ? 'home' : 'away';
  const faced = g[fieldingSide === 'home' ? 'homeBattersFaced' : 'awayBattersFaced'] || 0;
  const isPitcher = currentPos === 'P';

  const list = others.map(pid => {
    const p = State.getPlayer(pid);
    const otherPos = positions[pid] || 'BENCH';
    return `<button class="btn" style="display:flex; justify-content:space-between; width:100%; margin-bottom:6px;" onclick="swapFielderGuarded('${currentPid}', '${pid}', ${faced})">
      <span>${escapeHtml(p?.name || '?')}</span>
      <span class="pill">${otherPos}</span>
    </button>`;
  }).join('');

  // Show warning whenever the pitcher hasn't faced 4 batters yet AND the user
  // hasn't already dismissed the warning once this half-inning.
  // Exception: first-cycle pre-inning swaps where the incoming pitcher hasn't pitched yet.
  // Check if ANY available target qualifies as a free incoming pitcher (suppresses banner).
  const isFreeSwap = isInFirstCycle(g, fieldingSide) && !halfInningHasStarted(g)
    && others.some(pid => !hasPlayerPitchedThisGame(g, pid));
  let warningBanner = '';
  if (!isFreeSwap && faced < 4 && !_pitcherSwapWarningDismissed) {
    const msg = isPitcher
      ? `Pitcher has only faced <strong>${faced}</strong> of 4 required batters this inning.`
      : `The current pitcher has only faced <strong>${faced}</strong> of 4 required batters. Swapping them in would violate the pitching rule.`;
    warningBanner = `<div style="background:#fef9c3;border:1px solid #fde68a;border-radius:6px;padding:8px 10px;font-size:12px;color:#92400e;margin-bottom:10px">
        ⚠️ ${msg}
       </div>`;
  }

  Modal.show(`
    <div class="modal-header">
      <h3>Swap ${currentPos}: ${escapeHtml(cur?.name || '')}</h3>
      <button class="btn-icon" onclick="Modal.hide(); renderLiveGame('${g.id}')">✕</button>
    </div>
    <div class="modal-body">
      ${warningBanner}
      <p class="help-text" style="margin-bottom:10px">Pick a player to move into the ${currentPos} role. The current ${currentPos} will take their position.</p>
      ${list || '<div class="muted">No other players available.</div>'}
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="Modal.hide(); renderLiveGame('${g.id}')">Cancel</button>
    </div>
  `);
}

// Handles the 4-batter confirmation for pitcher swaps.
// The pitcher may be currentPid (direct swap) OR newPid (e.g. CF picking the pitcher as target).
function swapFielderGuarded(currentPid, newPid, faced) {
  const g = State.getGame(LiveGameId); if (!g) return;
  const positions = fieldingPositions(g);
  const pitcherInvolved = positions[currentPid] === 'P' || positions[newPid] === 'P';
  if (pitcherInvolved && faced < 4 && !_pitcherSwapWarningDismissed) {
    const fieldingSide = g.currentHalf === 'top' ? 'home' : 'away';
    // incomingPid = the player who will become the pitcher after the swap
    const incomingPid = positions[currentPid] === 'P' ? newPid : currentPid;
    const isFreeSwap = isInFirstCycle(g, fieldingSide) && !halfInningHasStarted(g)
                       && !hasPlayerPitchedThisGame(g, incomingPid);
    if (!isFreeSwap) {
      if (!confirm(`The current pitcher has only faced ${faced} batter${faced === 1 ? '' : 's'} (minimum 4 required). Swap anyway?`)) return;
      _pitcherSwapWarningDismissed = true;
    }
  }
  swapFielder(currentPid, newPid);
}

async function swapFielder(currentPid, newPid) {
  const g = State.getGame(LiveGameId); if (!g) return;
  const positions = { ...(g.currentHalf === 'top' ? g.homePositions : g.awayPositions) };
  const oldPos = positions[currentPid] || 'BENCH';
  const newOldPos = positions[newPid] || 'BENCH'; // guard: bench players may be absent from map
  positions[currentPid] = newOldPos;
  positions[newPid] = oldPos;
  const posKey = g.currentHalf === 'top' ? 'homePositions' : 'awayPositions';
  const patch = { [posKey]: positions };

  // If this is a pitcher swap, maintain the rotation index correctly:
  // - Pre-inning free swaps in the first cycle: update pitcherIdx so the new
  //   starter owns their rotation slot and EOI advances from them correctly.
  // - Mid-inning relief changes: do NOT touch pitcherIdx. The original starter's
  //   slot must be preserved so EOI advances to the correct next pitcher.
  // battersFaced is never reset here — it's a half-inning counter so the
  // 4-batter threshold applies to the whole inning regardless of relief changes.
  if (oldPos === 'P') {
    const fieldingSide = g.currentHalf === 'top' ? 'home' : 'away';
    const orderKey  = fieldingSide === 'home' ? 'homePitchingOrder' : 'awayPitchingOrder';
    const idxKey    = fieldingSide === 'home' ? 'homePitcherIdx'    : 'awayPitcherIdx';
    const order = g[orderKey] || [];
    const isFreeSwap = isInFirstCycle(g, fieldingSide) && !halfInningHasStarted(g)
                       && !hasPlayerPitchedThisGame(g, newPid);
    if (isFreeSwap) {
      // Pre-inning first-cycle swap: update rotation slot to the new starter
      const newIdx = order.indexOf(newPid);
      if (newIdx >= 0) patch[idxKey] = newIdx;
    }
    // Mid-inning relief: pitcherIdx stays unchanged — EOI advances from the starter
  }

  await State.updateGame(g.id, patch);
  Modal.hide();
  renderLiveGame(g.id);
  if (oldPos === 'P') {
    const pitcher = State.getPlayer(newPid);
    _queueAnim({ text: `${pitcher?.name || '?'} is now pitching`, color: '#a78bfa', holdMs: 2500 });
  } else {
    toast(`${oldPos}: ${State.getPlayer(newPid)?.name || '?'}`, 'success');
  }
}

/* ============================================================
   PITCH HANDLERS
   ============================================================ */
function attachPitchHandlers() {
  document.querySelectorAll('.pitch-buttons button, .pitch-buttons-compact button').forEach(btn => {
    btn.addEventListener('click', () => handlePitch(btn.dataset.pitch));
  });
}

async function handlePitch(kind) {
  const g = State.getGame(LiveGameId); if (!g) return;
  if (g.status === 'completed') return;
  if (!canUserScore()) { toast('You need scoring privilege to record plays', 'error'); return; }
  if (!await assertScoringLock(LiveGameId)) return;  // kicks to watch-only if lock was taken over
  _cancelAnim();  // abort any in-progress animation before the new action
  g.undoStack = [...(g.undoStack || []).slice(-14), captureSnapshot(g)];
  g.redoStack = [];

  // Capture count BEFORE any increment so we can hold the old value until the toast appears.
  // The fn queued before each toast clears the freeze so the count ticks up simultaneously
  // with the banner — matching the watcher path behaviour in _detectAndQueueAnims section 5.
  const prevCount = { balls: g.balls, strikes: g.strikes, fouls: g.fouls || 0 };

  if (kind === 'ball') {
    g.balls++;
    if (g.balls >= 4) {
      // Walk — outcome anim queued inside applyPaEnd
      await applyPaEnd(g, { outcome: 'BB' }, prevCount);
    } else {
      // Freeze to PRE-pitch count during ball flight; count increments at banner appearance
      _frozenCount = prevCount;
      _queueAnim({ text: 'Ball', color: '#fbbf24', fromSvg: FIELD.MOUND, toSvg: { x: 200, y: 368 },
        onBannerShow: () => { _frozenCount = null; if (LiveGameId) renderLiveGame(LiveGameId, LiveGameWatchOnly); }
      });
      await State.updateGame(g.id, { balls: g.balls });
      renderLiveGame(g.id);
    }
    return;
  }
  if (kind === 'strike_swinging' || kind === 'strike_looking') {
    g.strikes++;
    if (g.strikes >= 3) {
      // Strikeout — outcome anim queued inside applyPaEnd
      await applyPaEnd(g, { outcome: 'K', kType: kind === 'strike_swinging' ? 'swinging' : 'looking' }, prevCount);
    } else {
      // Freeze to PRE-pitch count during ball flight; count increments at banner appearance
      _frozenCount = prevCount;
      _queueAnim({ text: 'Strike ⚡', color: '#f87171', fromSvg: FIELD.MOUND, toSvg: FIELD.HOME,
        onBannerShow: () => { _frozenCount = null; if (LiveGameId) renderLiveGame(LiveGameId, LiveGameWatchOnly); }
      });
      await State.updateGame(g.id, { strikes: g.strikes });
      renderLiveGame(g.id);
    }
    return;
  }
  if (kind === 'foul') {
    g.fouls = (g.fouls || 0) + 1;
    if (g.fouls >= 5) {
      // Foul-out — outcome anim queued inside applyPaEnd
      await applyPaEnd(g, { outcome: 'FO' }, prevCount);
    } else {
      if (g.strikes < 2) g.strikes++;
      // Freeze to PRE-pitch count during ball flight; count increments at banner appearance
      _frozenCount = prevCount;
      const goRight = Math.random() < 0.5;
      _queueAnim({
        text: 'Foul!', color: '#fb923c',
        fromSvg:  FIELD.MOUND,
        viaSvg:   FIELD.HOME,
        toSvg:    goRight ? { x: 338, y: 352 } : { x: 62, y: 352 },
        phase1Dur: 380, phase2Dur: 340,
        onBannerShow: () => { _frozenCount = null; if (LiveGameId) renderLiveGame(LiveGameId, LiveGameWatchOnly); }
      });
      await State.updateGame(g.id, { strikes: g.strikes, fouls: g.fouls });
      renderLiveGame(g.id);
    }
    return;
  }
  if (kind === 'bip') {
    bipStart();
    return;
  }
}

/* ============================================================
   BIP FLOW — choices via modal, locate step inline on field
   ============================================================ */
let __pendingPlay = null;

function bipStart() {
  __bipStep = 'choose';
  __bipKind = null;
  __bipDetail = null;
  __pendingPlay = null;
  __fieldClickMode = null;
  Modal.show(`
    <div class="modal-header">
      <h3>Ball in play</h3>
      <button class="btn-icon" onclick="bipCancel()">✕</button>
    </div>
    <div class="modal-body">
      <div class="outcome-grid">
        <button onclick="bipChooseKind('out')" style="background:#fee2e2;border-color:#fca5a5;color:#991b1b">Out</button>
        <button onclick="bipChooseKind('hit')" style="background:#dcfce7;border-color:#86efac;color:#166534">Hit</button>
        <button onclick="bipChooseKind('error')" style="background:#fef9c3;border-color:#fde047;color:#854d0e">Error</button>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="bipCancel()">Cancel</button>
    </div>`);
}

function bipChooseKind(kind) {
  __bipKind = kind;
  if (kind === 'hr') {
    __bipDetail = 'HR';
    __bipStep = 'locate';
    Modal.hide();
    bipEnterLocate();
    rerenderBipPanel();
    return;
  }
  __bipStep = 'subtype';
  const titles = { out: 'Type of out', hit: 'Hit', error: 'Error — batter reaches' };
  const grids = {
    out: `
      <button onclick="bipChooseDetail('GB')">Ground ball<span class="sub">GB</span></button>
      <button onclick="bipChooseDetail('LD')">Line drive<span class="sub">LD</span></button>
      <button onclick="bipChooseDetail('FB')">Fly ball<span class="sub">FB</span></button>`,
    hit: `
      <button onclick="bipChooseDetail('1B')">Single<span class="sub">1B</span></button>
      <button onclick="bipChooseDetail('2B')">Double<span class="sub">2B</span></button>
      <button onclick="bipChooseKind('hr')">Home Run<span class="sub">HR</span></button>`,
    error: `
      <button onclick="bipChooseDetail('1B')">Single<span class="sub">1B</span></button>
      <button onclick="bipChooseDetail('2B')">Double<span class="sub">2B</span></button>
      <button onclick="bipChooseDetail('HR')">Home Run<span class="sub">HR</span></button>`,
  };
  Modal.show(`
    <div class="modal-header">
      <h3>${titles[kind]}</h3>
      <button class="btn-icon" onclick="bipCancel()">✕</button>
    </div>
    <div class="modal-body">
      <div class="outcome-grid">${grids[kind]}</div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="bipStart()">← Back</button>
      <button class="btn" onclick="bipCancel()">Cancel</button>
    </div>`);
}

function bipChooseDetail(detail) {
  __bipDetail = detail;
  __bipStep = 'locate';
  Modal.hide();
  bipEnterLocate();
  rerenderBipPanel();
}

function bipEnterLocate() {
  const needFielder = __bipKind === 'out' || __bipKind === 'error';
  __pendingPlay = { kind: __bipKind, detail: __bipDetail, fielderId: null, location: null };
  __fieldClickMode = {
    needFielder,
    onDragEnd(fielderId, loc) {
      __pendingPlay.fielderId = fielderId;
      __pendingPlay.location = loc;
      bipConfirm();
    }
  };
  drawField();
}

function rerenderBipPanel() {
  const g = State.getGame(LiveGameId);
  const panel = $('#bip-panel');
  if (panel && g) {
    panel.innerHTML = renderBipPanel(g);
    attachPitchHandlers();
  }
}

function renderBipPanel(g) {
  // In locate mode keep pitch buttons visible but dimmed so #bip-panel height
  // never changes — instruction + cancel live in the SVG overlay instead.
  // Also disable during animations so nothing can be entered while a toast is showing.
  const locked = __bipStep === 'locate' || _animInputLocked;
  return `
    <div class="pitch-buttons-compact"${locked ? ' style="opacity:0.3;pointer-events:none"' : ''}>
      <button data-pitch="ball">Ball</button>
      <button data-pitch="strike_swinging">Strike<small>Swinging</small></button>
      <button data-pitch="strike_looking">Strike<small>Looking</small></button>
      <button data-pitch="foul">Foul</button>
      <button data-pitch="bip" class="btn-bip">In Play</button>
    </div>`;
}

async function bipConfirm() {
  if (!__pendingPlay?.location) return;
  const needFielder = __pendingPlay.kind === 'out' || __pendingPlay.kind === 'error';
  if (needFielder && !__pendingPlay.fielderId) return;
  const { kind, detail, fielderId, location } = __pendingPlay;
  __pendingPlay = null;
  __fieldClickMode = null;
  __bipStep = null; __bipKind = null; __bipDetail = null;
  if (kind === 'out')   await finishOut(detail, fielderId, location);
  if (kind === 'hit')   await finishHit(detail, fielderId, location);
  if (kind === 'hr')    await finishHit('HR', null, location);
  if (kind === 'error') await finishError(detail, fielderId, location);
}

function bipCancel() {
  __pendingPlay = null;
  __fieldClickMode = null;
  __bipStep = null; __bipKind = null; __bipDetail = null;
  // Remove the phantom undo entry pushed when BIP was initiated but cancelled
  const _gBip = State.getGame(LiveGameId);
  if (_gBip) _gBip.undoStack = (_gBip.undoStack || []).slice(0, -1);
  Modal.hide();
  renderLiveGame(LiveGameId);
}

function drawBallMarker(loc) {
  const svg = $('#field-svg'); if (!svg) return;
  let m = svg.querySelector('.ball-marker');
  if (!m) {
    m = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    m.setAttribute('class', 'ball-marker');
    m.setAttribute('r', 6);
    svg.appendChild(m);
  }
  m.setAttribute('cx', loc.x);
  m.setAttribute('cy', loc.y);
}


/* ============================================================
   PA RESOLUTION
   ============================================================ */
let __pendingOutArgs = null;

function playerInitials(playerId) {
  const p = State.getPlayer(playerId);
  if (!p || !p.name) return '?';
  return p.name.trim().split(/\s+/).map(w => w[0]).join('').toUpperCase();
}

// Returns the base number of the lead runner in the force chain (requires runner on 1st)
function leadForcedBase(bases) {
  if (!bases[1]) return null;
  if (bases[2] && bases[3]) return 3;
  if (bases[2]) return 2;
  return 1;
}

async function finishOut(hitType, fielderId, location) {
  const g = State.getGame(LiveGameId);

  // Double play opportunity: ground ball, runner on 1st, fewer than 2 outs
  if (hitType === 'GB' && g.outs < 2 && g.bases[1]) {
    __pendingOutArgs = { hitType, fielderId, location };
    showDoublePlayPrompt(g);
    return;
  }

  // Sacrifice fly / tag-up: fly ball, runner on 3rd, fewer than 2 outs
  if (hitType === 'FB' && g.outs < 2 && g.bases[3]) {
    __pendingOutArgs = { hitType, fielderId, location };
    showTagUpPrompt(g);
    return;
  }

  await applyPaEnd(g, { outcome: 'OUT', hitType, fielderId, location });
}

function showDoublePlayPrompt(g) {
  const dpBase = leadForcedBase(g.bases);
  const runner  = dpBase ? g.bases[dpBase] : null;
  const ri = runner ? playerInitials(runner.playerId) : '?';
  Modal.show(`
    <div class="modal-header"><h3>Double Play?</h3></div>
    <div class="modal-body" style="padding:16px">
      <p style="margin:0 0 8px;font-size:15px">Was a double play attempted?</p>
      <p style="margin:0;font-size:13px;color:#6b7280">Lead runner: <strong>${ri}</strong></p>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="applyDoublePlay(false,false)">No</button>
      <button class="btn btn-primary" onclick="showDoublePlayResult()">Yes — attempted</button>
    </div>`);
}

function showDoublePlayResult() {
  Modal.show(`
    <div class="modal-header"><h3>Double Play Result</h3></div>
    <div class="modal-body" style="padding:16px">
      <p style="margin:0;font-size:15px">Was the double play successful?</p>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="applyDoublePlay(true,false)">No — runner safe</button>
      <button class="btn btn-primary" onclick="applyDoublePlay(true,true)">Yes — two outs</button>
    </div>`);
}

async function applyDoublePlay(attempted, successful) {
  const args = __pendingOutArgs;
  __pendingOutArgs = null;
  Modal.hide();
  const g = State.getGame(LiveGameId);
  const dpBase = (attempted && successful) ? leadForcedBase(g.bases) : null;
  await applyPaEnd(g, { outcome: 'OUT', hitType: args.hitType, fielderId: args.fielderId, location: args.location, doublePlayBase: dpBase, dpAttempted: attempted });
}

function showTagUpPrompt(g) {
  const runner = g.bases[3];
  const ri = runner ? playerInitials(runner.playerId) : '?';
  Modal.show(`
    <div class="modal-header"><h3>Tag Up?</h3></div>
    <div class="modal-body" style="padding:16px">
      <p style="margin:0 0 8px;font-size:15px">Did the runner on 3rd tag up?</p>
      <p style="margin:0;font-size:13px;color:#6b7280">Runner: <strong>${ri}</strong></p>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="applyTagUp(false,false)">No — stayed</button>
      <button class="btn btn-primary" onclick="showTagUpResult()">Yes — tagged up</button>
    </div>`);
}

function showTagUpResult() {
  Modal.show(`
    <div class="modal-header"><h3>Tag Up Result</h3></div>
    <div class="modal-body" style="padding:16px">
      <p style="margin:0;font-size:15px">Did the runner score?</p>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="applyTagUp(true,false)">No — thrown out</button>
      <button class="btn btn-primary" onclick="applyTagUp(true,true)">Yes — scored!</button>
    </div>`);
}

async function applyTagUp(tagged, scored) {
  const args = __pendingOutArgs;
  __pendingOutArgs = null;
  Modal.hide();
  const g = State.getGame(LiveGameId);
  await applyPaEnd(g, {
    outcome: 'OUT',
    hitType: args.hitType,
    fielderId: args.fielderId,
    location: args.location,
    sacFlyScored: tagged && scored,
    sacFlyOut:    tagged && !scored,
  });
}

async function finishHit(hitDetail, fielderId, location) {
  const g = State.getGame(LiveGameId);
  await applyPaEnd(g, { outcome: hitDetail, fielderId, location });
}

async function finishError(errBase, errorById, location) {
  const g = State.getGame(LiveGameId);
  await applyPaEnd(g, { outcome: 'ERR_REACH', errBase, errorById, location });
}

async function applyPaEnd(g, ev, prePitchCount = null) {
  if (!await assertScoringLock(g.id)) return;
  const batterId  = currentBatterId(g);
  const pitcherId = currentPitcherId(g);
  const inning = g.currentInning;
  const half   = g.currentHalf;

  const event = {
    type: 'pa_end',
    ts: Date.now(),
    inning, half,
    batterId,
    pitcherId,
    scoredBy: currentUser?.uid || null,
    scoredByName: currentUserProfile?.name || currentUser?.email?.split('@')[0] || null,
    outcome: ev.outcome,
    kType: ev.kType || null,
    hitType: ev.hitType || null,
    errBase: ev.errBase || null,
    errorById: ev.errorById || null,
    fielderId: ev.fielderId || null,
    location: ev.location || null,
    doublePlay: !!ev.doublePlayBase,
    dpAttempted: !!ev.dpAttempted,
    sacFly: !!(ev.sacFlyScored || ev.sacFlyOut),
    sacFlyOut: !!ev.sacFlyOut,
    countBalls:   g.balls   || 0,
    countStrikes: g.strikes || 0,
    countFouls:   g.fouls   || 0,
    rbi: 0,
    earnedRuns: 0,
    runsScoredBy: [],
    pitches: (g.balls || 0) + (g.strikes || 0) + (g.fouls || 0) + (['BB','K','FO'].includes(ev.outcome) ? 0 : 1),
    strikePitches: (g.strikes || 0) + (g.fouls || 0) + (['BB','K','FO'].includes(ev.outcome) ? 0 : 1),
  };

  // ── Compute new game state (bases, score, outs) ───────────────────────────
  const newBases = { 1: g.bases[1], 2: g.bases[2], 3: g.bases[3] };
  let runs = [];
  let outsToAdd = 0;
  let batterRunner = null;

  if (ev.outcome === 'BB') {
    batterRunner = makeRunner(g, batterId);
    const res = walkAdvance(newBases, batterRunner);
    Object.assign(newBases, res.newBases);
    runs = res.runnerIdsScored;
  } else if (ev.outcome === 'K' || ev.outcome === 'FO' || ev.outcome === 'OUT') {
    outsToAdd = 1;
  } else if (['1B','2B','3B','HR'].includes(ev.outcome)) {
    const target = ({ '1B': 1, '2B': 2, '3B': 3, 'HR': 4 })[ev.outcome];
    batterRunner = makeRunner(g, batterId);
    const res = hitAdvance(newBases, target, batterRunner);
    Object.assign(newBases, res.newBases);
    runs = res.runnerIdsScored;
  } else if (ev.outcome === 'ERR_REACH') {
    const target = ({ '1B': 1, '2B': 2, '3B': 3, 'HR': 4 })[ev.errBase] || 1;
    batterRunner = makeRunner(g, batterId);
    const res = advanceRunners(newBases, target, batterRunner);
    Object.assign(newBases, res.newBases);
    runs = res.runnerIdsScored;
  }

  if (ev.doublePlayBase) {
    newBases[ev.doublePlayBase] = null;
    outsToAdd += 1;
  }
  if (ev.sacFlyScored) {
    const r3 = newBases[3];
    if (r3) runs.push(r3.id);
    newBases[3] = null;
  }
  if (ev.sacFlyOut) {
    newBases[3] = null;
    outsToAdd += 1;
  }

  const allRunners = [
    g.bases[1], g.bases[2], g.bases[3],
    newBases[1], newBases[2], newBases[3],
    batterRunner,
  ].filter(Boolean);
  const findRunner = (rid) => allRunners.find(r => r.id === rid);
  event.runsScoredBy = runs.map(rid => {
    const r = findRunner(rid); return r ? r.playerId : null;
  }).filter(Boolean);

  const runsCount = runs.length;
  if (ev.outcome !== 'ERR_REACH') {
    event.rbi = runsCount;
    event.earnedRuns = runsCount; // total, kept for team stats and backward compat
    // Attribution: split earned runs to whichever pitcher put each runner on base.
    // Runners inherit ownedByPitcherId from makeRunner; old runners without it fall
    // back to the current pitcher so existing game data isn't broken.
    const erByPitcher = {};
    for (const rid of runs) {
      const runner = findRunner(rid);
      const ownerPid = runner?.ownedByPitcherId || pitcherId;
      erByPitcher[ownerPid] = (erByPitcher[ownerPid] || 0) + 1;
    }
    event.earnedRunsByPitcher = erByPitcher;
  }

  const newScore = { ...g.score };
  if (half === 'top') newScore.away += runsCount;
  else                newScore.home += runsCount;

  const lineScore = ensureLineScore(g);
  const inningEntry = lineScore.find(x => x.inning === inning);
  if (inningEntry) {
    if (half === 'top') inningEntry.top += runsCount;
    else                inningEntry.bottom += runsCount;
  }

  const newOuts = g.outs + outsToAdd;
  event.basesAfter = { 1: newBases[1], 2: newBases[2], 3: newBases[3] };
  event.scoreAfter = { ...newScore };
  event.outsAfter  = newOuts;
  const newEvents = [...(g.events || []), event];
  const idxKey = battingIdxKey(g);
  const newBatterIdx = g[idxKey] + 1;

  const fieldingSide = half === 'top' ? 'home' : 'away';
  const facedKey = fieldingSide === 'home' ? 'homeBattersFaced' : 'awayBattersFaced';

  // ── Queue outcome animation for the scorer ────────────────────────────────
  // Freeze PRE-play display state while the toast shows:
  //   • count: starts at PRE-PITCH values during ball flight; increments to FINAL at banner
  //   • score / outs / bases: frozen at PRE-play values — reveals POST-play after toast
  //   • batter / pitcher: frozen at pre-play values so they stay visible during toast
  //   • input: locked so no buttons can be pressed during the toast
  if (!LiveGameWatchOnly) {
    const anim = _buildOutcomeAnim(event, g);
    if (anim) {
      _animInputLocked  = true;
      const finalCount  = { balls: g.balls, strikes: g.strikes, fouls: g.fouls || 0 };
      // During ball flight: show PRE-pitch count (passed from handlePitch).
      // For BIP outcomes (no count change), prePitchCount is null so finalCount is used.
      _frozenCount      = prePitchCount || finalCount;
      _frozenBatterId   = batterId;
      _frozenPitcherId  = pitcherId;
      _frozenScore      = { ...g.score };
      _frozenOuts       = g.outs;
      _frozenBases      = JSON.parse(JSON.stringify(g.bases || {}));
      // Freeze half/inning so the scoreboard and fielder circles don't flip to the new
      // inning when endHalfInningInternal saves to Firestore mid-animation-queue.
      _frozenHalf       = g.currentHalf;
      _frozenInning     = g.currentInning;
      // At the moment the banner appears (after ball flight), snap count to FINAL value
      anim.onBannerShow = () => {
        _frozenCount = finalCount;
        if (LiveGameId) renderLiveGame(LiveGameId, LiveGameWatchOnly);
      };
      _queueAnim(anim);
      // Snapshot spray chart BEFORE the save so the new dot is excluded during animation
      if (_sprayChartVisible && batterId) {
        _sprayBatterId   = batterId;
        _sprayCachedDots = getSprayData(batterId);
      }
    }
  }

  // ── Save to Firestore ─────────────────────────────────────────────────────
  const patch = {
    bases: newBases,
    outs: newOuts,
    balls: 0,
    strikes: 0,
    fouls: 0,
    score: newScore,
    lineScore,
    events: newEvents,
    [idxKey]: newBatterIdx,
    runnerCounter: g.runnerCounter || 0,
    [facedKey]: (g[facedKey] || 0) + 1,
  };

  await State.updateGame(g.id, patch);
  const fresh = State.getGame(g.id);
  const isThirdOut = fresh?.outs >= 3;
  await postPlayCheck(fresh);
  Modal.hide();
  renderLiveGame(g.id);

  // For non-3rd-out, non-game-ending outcomes: unfreeze after the outcome toast
  // (for 3rd out / game end, postPlayCheck already queued the full cleanup sequence)
  if (!LiveGameWatchOnly && _animInputLocked) {
    const fresh2 = State.getGame(g.id);
    if (!isThirdOut && fresh2?.status !== 'completed') {
      _queueAnim({ fn: () => {
        _frozenCount     = null;
        _frozenBatterId  = null;
        _frozenPitcherId = null;
        _animInputLocked = false;
        _unfreezeDisplay();
      }});
    }
  }
}

function ensureLineScore(g) {
  const ls = [...(g.lineScore || [])];
  while (ls.length < g.currentInning) {
    ls.push({ inning: ls.length + 1, top: 0, bottom: 0 });
  }
  return ls;
}

async function postPlayCheck(g) {
  if (g.outs >= 3) {
    if (!LiveGameWatchOnly) {
      const halfLabel = g.currentHalf === 'top' ? 'Top' : 'Bottom';
      // Capture the 3rd-out value NOW before endHalfInningInternal resets g.outs to 0.
      const endOuts = g.outs;

      // After outcome toast: clear count, show 3rd out (frozen), keep everything else.
      // batter/pitcher/half/inning all stay frozen so the display still shows the OLD
      // inning's players and indicator through the EOI toast.
      // _animInputLocked stays true — buttons remain disabled.
      _queueAnim({ fn: () => {
        _frozenCount     = null;
        // _frozenBatterId  stays set — old batter stays visible during EOI
        // _frozenPitcherId stays set — old pitcher stays visible during EOI
        _frozenScore     = null;
        _frozenOuts      = endOuts;  // show 3rd out (real value, e.g. 3) during EOI
        _frozenBases     = null;
        // _frozenHalf / _frozenInning stay set — keep old inning display and fielders
        // _betweenInnings stays false — fielders from this inning remain visible
        if (LiveGameId) renderLiveGame(LiveGameId, LiveGameWatchOnly);
      }});

      // End-of-inning banner: outs=3, old fielders/batter/pitcher still visible
      _queueAnim({ text: `End of ${halfLabel} ${ordinal(g.currentInning)}`, color: '#60a5fa', holdMs: 1400 });

      // After EOI toast: blank field — clear all frozen state, hide all circles/names.
      // Release the half/inning freeze so the scoreboard updates to the new inning.
      _queueAnim({ fn: () => {
        const g2 = State.getGame(LiveGameId);
        if (!g2 || g2.status === 'completed') return; // game ended — finishGame handles it
        _frozenHalf      = null;
        _frozenInning    = null;
        _frozenOuts      = null;
        _frozenBatterId  = null;
        _frozenPitcherId = null;
        _betweenInnings  = true;
        if (LiveGameId) renderLiveGame(LiveGameId, LiveGameWatchOnly);
      }});
      // Hold on the blank field for the same duration as the watcher path
      _queueAnim({ blank: true, holdMs: 2000 });
    }

    await endHalfInningInternal(g);

    // If endHalfInningInternal opened the end-game decision dialog, pause here.
    // The dialog's "End Game" / "Continue" buttons will resume the animation sequence.
    if (_pendingEndGameDecision) return;

    if (!LiveGameWatchOnly) {
      const fresh = State.getGame(g.id);
      if (fresh && fresh.status === 'in_progress') {
        const halfLabel2 = fresh.currentHalf === 'top' ? '▲ Top' : '▼ Bottom';
        // At the moment the start-of-inning banner appears, reveal new inning fielders
        _queueAnim({
          text: `${halfLabel2} of the ${ordinal(fresh.currentInning)}`,
          color: '#60a5fa', holdMs: 1800,
          onBannerShow: () => {
            _betweenInnings  = false;
            _animInputLocked = false;
            if (LiveGameId) renderLiveGame(LiveGameId, LiveGameWatchOnly);
          }
        });
      }
      _queueAnim({ fn: _unfreezeDisplay });
    }
    return;
  }
  // Walk-off: home batting in final inning or extras and they've taken the lead
  if (g.currentHalf === 'bottom' && g.currentInning >= g.numInnings && g.score.home > g.score.away) {
    await finishGame(g, 'walkoff');
  }
}

// Returns true if the fielding side is still within their first rotation cycle —
// i.e. not all pitchers in the rotation have had a starting inning yet.
function isInFirstCycle(g, side) {
  const orderKey = side === 'home' ? 'homePitchingOrder' : 'awayPitchingOrder';
  const order = g[orderKey] || [];
  if (order.length < 2) return false;
  // Count unique innings this side has fielded (home fields top, away fields bottom)
  const fieldingHalf = side === 'home' ? 'top' : 'bottom';
  const innings = new Set();
  (g.events || []).forEach(e => {
    if (e.type === 'pa_end' && e.half === fieldingHalf) innings.add(e.inning);
  });
  return innings.size < order.length;
}

// Returns true if the current half-inning has already begun (at least one
// batter has been retired/walked, or pitches have been thrown in the current PA).
function halfInningHasStarted(g) {
  const fieldingSide = g.currentHalf === 'top' ? 'home' : 'away';
  const faced = g[fieldingSide === 'home' ? 'homeBattersFaced' : 'awayBattersFaced'] || 0;
  return faced > 0 || (g.balls || 0) + (g.strikes || 0) + (g.fouls || 0) > 0;
}

// Returns true if the given player has appeared as a pitcher in any completed PA this game.
// Used to restrict first-cycle free swaps to pitchers who haven't thrown a pitch yet.
function hasPlayerPitchedThisGame(g, pid) {
  return (g.events || []).some(e => e.type === 'pa_end' && e.pitcherId === pid);
}

// Returns position-map patch that cycles to next pitcher for the given side,
// plus resets battersFaced for that side. Returns null if no rotation data.
function buildPitcherCyclePatch(g, side) {
  const orderKey   = side === 'home' ? 'homePitchingOrder'  : 'awayPitchingOrder';
  const idxKey     = side === 'home' ? 'homePitcherIdx'     : 'awayPitcherIdx';
  const facedKey   = side === 'home' ? 'homeBattersFaced'   : 'awayBattersFaced';
  const posKey     = side === 'home' ? 'homePositions'      : 'awayPositions';

  const order = g[orderKey];
  if (!order || order.length < 2) return null;

  const curIdx  = g[idxKey] ?? 0;
  const nextIdx = (curIdx + 1) % order.length;

  const curPid  = order[curIdx];
  const nextPid = order[nextIdx];

  // Swap P with next pitcher's current position
  const positions = { ...(g[posKey] || {}) };
  const nextOldPos = positions[nextPid] || 'BENCH';
  positions[nextPid] = 'P';
  positions[curPid]  = nextOldPos;

  return {
    [posKey]:  positions,
    [idxKey]:  nextIdx,
    [facedKey]: 0,
  };
}

async function endHalfInningInternal(g) {
  _pitcherSwapWarningDismissed = false;
  let { currentInning, currentHalf } = g;
  if (currentHalf === 'top') {
    currentHalf = 'bottom';
    // Home already leads after top of last inning — no need to bat
    if (currentInning >= g.numInnings && g.score.home > g.score.away) {
      await finishGame(g, 'home_leads_after_top');
      return;
    }
  } else {
    currentInning++;
    currentHalf = 'top';
    if (currentInning > g.numInnings && g.score.home !== g.score.away) {
      _showEndGameDialog(g);
      return;
    }
    // If tied, continue into extras
  }

  // Cycle the pitcher for the team that JUST FINISHED fielding so they're ready
  // for their next appearance — NOT the team about to field (they use their current
  // pitcher, already set). After transitioning:
  //   new 'bottom' half → home just fielded → cycle home pitcher
  //   new 'top' half    → away just fielded → cycle away pitcher
  const fieldingSide = currentHalf === 'top' ? 'away' : 'home';
  const cyclePatch = buildPitcherCyclePatch(g, fieldingSide) || {};

  await State.updateGame(g.id, {
    currentInning, currentHalf,
    outs: 0, balls: 0, strikes: 0, fouls: 0,
    bases: { 1: null, 2: null, 3: null },
    ...cyclePatch,
  });
  const fresh = State.getGame(g.id);
  await State.updateGame(g.id, { lineScore: ensureLineScore(fresh) });
}

async function finishGame(g, _reason) {
  if (!LiveGameWatchOnly) {
    const away   = State.getTeam(g.awayTeamId);
    const home   = State.getTeam(g.homeTeamId);
    const winner = g.score.away > g.score.home ? away
                 : g.score.home > g.score.away ? home : null;
    _queueAnim({
      text: winner ? `${winner.name} win! 🏆` : "It's a tie! 🏁",
      color: '#fde68a', big: true, holdMs: 2400,
    });
    // Always unfreeze after the game-over toast — covers walk-offs and any other
    // game-ending path where postPlayCheck's normal EOI cleanup doesn't run.
    _queueAnim({ fn: _unfreezeDisplay });
  }
  await State.updateGame(g.id, { status: 'completed', isOver: true });
  autoSendRecapEmails(g.id);
  Render.games();
  if (g.tournamentId) {
    Render.tournaments();
    await autoGenerateTournamentRound(g.tournamentId);
  }
}

// Shows a modal dialog asking whether to end the game or continue playing.
// Called when regulation innings are complete and the score is not tied.
// Sets _pendingEndGameDecision = true; the modal buttons call the functions below.
function _showEndGameDialog(g) {
  _pendingEndGameDecision = true;
  const away = State.getTeam(g.awayTeamId);
  const home = State.getTeam(g.homeTeamId);
  const winner = g.score.away > g.score.home ? away : home;
  const score = `${g.score.away}–${g.score.home}`;
  Modal.show(`
    <div class="modal-header"><h3>End of ${g.numInnings} Innings</h3></div>
    <div class="modal-body" style="padding:16px">
      <p style="font-size:15px;margin:0 0 8px">
        <strong>${escapeHtml(winner?.name || '?')}</strong> leads ${score}.
      </p>
      <p style="font-size:13px;color:#6b7280;margin:0">End the game here, or continue playing?</p>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="Modal.hide(); continueExtraInnings('${g.id}')">Continue Playing</button>
      <button class="btn btn-primary" onclick="Modal.hide(); endGameFromDialog('${g.id}')">End Game</button>
    </div>
  `);
}

async function endGameFromDialog(gameId) {
  _pendingEndGameDecision = false;
  const g = State.getGame(gameId); if (!g) return;
  await finishGame(g, 'regulation');
}

async function continueExtraInnings(gameId) {
  _pendingEndGameDecision = false;
  const g = State.getGame(gameId); if (!g) return;
  // Transition: bottom of last inning just ended → top of next inning.
  // Away was fielding the bottom, so cycle their pitcher.
  const nextInning = g.currentInning + 1;
  const cyclePatch = buildPitcherCyclePatch(g, 'away') || {};
  await State.updateGame(gameId, {
    currentInning: nextInning, currentHalf: 'top',
    outs: 0, balls: 0, strikes: 0, fouls: 0,
    bases: { 1: null, 2: null, 3: null },
    ...cyclePatch,
  });
  const fresh = State.getGame(gameId);
  await State.updateGame(gameId, { lineScore: ensureLineScore(fresh) });
  const fresh2 = State.getGame(gameId);
  if (fresh2 && LiveGameId === gameId && !LiveGameWatchOnly) {
    _queueAnim({
      text: `▲ Top of the ${ordinal(fresh2.currentInning)}`,
      color: '#60a5fa', holdMs: 1800,
      onBannerShow: () => {
        _betweenInnings  = false;
        _animInputLocked = false;
        if (LiveGameId) renderLiveGame(LiveGameId, LiveGameWatchOnly);
      }
    });
    _queueAnim({ fn: _unfreezeDisplay });
  }
}

function showSkipBatterModal() {
  const g = State.getGame(LiveGameId); if (!g) return;
  const batter = State.getPlayer(currentBatterId(g));
  Modal.show(`
    <div class="modal-header"><h3>Skip Batter?</h3></div>
    <div class="modal-body" style="padding:16px">
      <p style="margin:0;font-size:15px">Skip <strong>${escapeHtml(batter?.name || '?')}</strong> and move to the next batter?</p>
      <p style="margin:8px 0 0;font-size:13px;color:#6b7280">No stats will be recorded for this plate appearance.</p>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="Modal.hide()">Cancel</button>
      <button class="btn btn-primary" onclick="skipBatter()">Skip</button>
    </div>`);
}

async function skipBatter() {
  Modal.hide();
  const g = State.getGame(LiveGameId); if (!g) return;
  if (!await assertScoringLock(g.id)) return;
  _cancelAnim();
  g.undoStack = [...(g.undoStack || []).slice(-14), captureSnapshot(g)];
  g.redoStack = [];
  const idxKey = battingIdxKey(g);
  await State.updateGame(g.id, { [idxKey]: g[idxKey] + 1, balls: 0, strikes: 0, fouls: 0 });
  renderLiveGame(g.id);
}

async function endHalfInning(gameId) {
  if (!await assertScoringLock(gameId)) return;
  if (!confirm('End this half-inning early? The current at-bat will be discarded.')) return;
  const g = State.getGame(gameId); if (!g) return;
  await endHalfInningInternal(g);
  renderLiveGame(gameId);
}

async function endGameEarly(gameId) {
  if (!await assertScoringLock(gameId)) return;
  if (!confirm('End the game now? Final scores will be locked.')) return;
  const g = State.getGame(gameId); if (!g) return;
  await State.updateGame(gameId, { status: 'completed', isOver: true });
  autoSendRecapEmails(gameId);
  renderLiveGame(gameId);
  Render.games();
  if (g.tournamentId) {
    Render.tournaments();
    await autoGenerateTournamentRound(g.tournamentId);
  }
}

async function swapHomeAway(gameId) {
  const g = State.getGame(gameId); if (!g) return;
  if ((g.events || []).length > 0 || g.balls > 0 || g.strikes > 0 || (g.fouls || 0) > 0) {
    toast('Cannot swap after scoring has begun', 'error'); return;
  }
  if (!await assertScoringLock(gameId)) return;
  // Swap every home/away field so the teams simply change sides
  await State.updateGame(gameId, {
    homeTeamId:         g.awayTeamId,
    awayTeamId:         g.homeTeamId,
    homeBattingOrder:   g.awayBattingOrder   || [],
    awayBattingOrder:   g.homeBattingOrder   || [],
    homePositions:      g.awayPositions      || {},
    awayPositions:      g.homePositions      || {},
    homePitchingOrder:  g.awayPitchingOrder  || [],
    awayPitchingOrder:  g.homePitchingOrder  || [],
    homePitcherIdx:     g.awayPitcherIdx     ?? 0,
    awayPitcherIdx:     g.homePitcherIdx     ?? 0,
    homeBatterIdx:      g.awayBatterIdx      ?? 0,
    awayBatterIdx:      g.homeBatterIdx      ?? 0,
    homeBattersFaced:   g.awayBattersFaced   ?? 0,
    awayBattersFaced:   g.homeBattersFaced   ?? 0,
  });
  renderLiveGame(gameId, LiveGameWatchOnly);
  toast('Home and away teams swapped');
}

/* ============================================================
   ADMIN: EDIT GAME AFTER THE FACT
   ============================================================ */
let _editScoreLS = null;

function showEditScoreModal(gameId) {
  const g = State.getGame(gameId); if (!g) return;
  const home = State.getTeam(g.homeTeamId);
  const away = State.getTeam(g.awayTeamId);
  _editScoreLS = JSON.parse(JSON.stringify(ensureLineScore(g)));

  const renderRows = () => _editScoreLS.map((inn, i) => `
    <tr>
      <td style="text-align:center;font-weight:600;padding:4px 8px">${inn.inning}</td>
      <td>
        <div class="score-edit-cell">
          <button class="btn btn-sm" onclick="_esAdj(${i},'top',-1)">−</button>
          <span id="es-top-${i}" style="min-width:24px;text-align:center;display:inline-block">${inn.top}</span>
          <button class="btn btn-sm" onclick="_esAdj(${i},'top',1)">+</button>
        </div>
      </td>
      <td>
        <div class="score-edit-cell">
          <button class="btn btn-sm" onclick="_esAdj(${i},'bottom',-1)">−</button>
          <span id="es-bot-${i}" style="min-width:24px;text-align:center;display:inline-block">${inn.bottom}</span>
          <button class="btn btn-sm" onclick="_esAdj(${i},'bottom',1)">+</button>
        </div>
      </td>
    </tr>`).join('');

  Modal.show(`
    <div class="modal-header">
      <h2>Edit Score — ${escapeHtml(away.name)} @ ${escapeHtml(home.name)}</h2>
      <button class="btn-icon" onclick="Modal.hide()">✕</button>
    </div>
    <div class="modal-body">
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr>
            <th style="text-align:center;padding:4px 8px;font-size:12px;color:#6b7280">Inn</th>
            <th style="padding:4px 8px;font-size:12px;color:#6b7280">${escapeHtml(away.name)} (Away)</th>
            <th style="padding:4px 8px;font-size:12px;color:#6b7280">${escapeHtml(home.name)} (Home)</th>
          </tr>
        </thead>
        <tbody id="es-tbody">${renderRows()}</tbody>
      </table>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="Modal.hide()">Cancel</button>
      <button class="btn btn-primary" onclick="_esSave('${gameId}')">Save</button>
    </div>`);
}

function _esAdj(idx, half, delta) {
  if (!_editScoreLS) return;
  const key = half === 'top' ? 'top' : 'bottom';
  _editScoreLS[idx][key] = Math.max(0, (_editScoreLS[idx][key] || 0) + delta);
  const spanId = half === 'top' ? `es-top-${idx}` : `es-bot-${idx}`;
  const span = document.getElementById(spanId);
  if (span) span.textContent = _editScoreLS[idx][key];
}

async function _esSave(gameId) {
  const g = State.getGame(gameId); if (!g || !_editScoreLS) return;
  let awayScore = 0, homeScore = 0;
  _editScoreLS.forEach(inn => { awayScore += inn.top; homeScore += inn.bottom; });
  await State.updateGame(gameId, { lineScore: _editScoreLS, score: { away: awayScore, home: homeScore } });
  _editScoreLS = null;
  Modal.hide();
  renderLiveGame(gameId, LiveGameWatchOnly);
  toast('Score updated');
}

async function reopenGame(gameId) {
  if (!confirm('Reopen this game? It will go back to in-progress status.')) return;
  const g = State.getGame(gameId); if (!g) return;
  await State.updateGame(gameId, { status: 'in_progress', isOver: false });
  Render.games();
  await openGameForScoring(gameId);
  toast('Game reopened');
}

/* ============================================================
   END-OF-GAME ACCOLADES
   ============================================================ */
function computeGameAccolades(g) {
  const allPids = [...new Set([...(g.homeBattingOrder||[]), ...(g.awayBattingOrder||[])])];
  const ps = {};
  allPids.forEach(id => { ps[id] = { hits:0, rbi:0, hr:0, r:0, bb:0, kp:0, xbh:0, err:0 }; });
  (g.events||[]).forEach(e => {
    if (e.type !== 'pa_end') return;
    const b = ps[e.batterId], pit = ps[e.pitcherId];
    if (b) {
      if (e.outcome==='BB') b.bb++;
      if (['1B','2B','3B','HR'].includes(e.outcome)) { b.hits++; if (e.outcome!=='1B') b.xbh++; }
      if (e.outcome==='HR') b.hr++;
      b.rbi += e.rbi||0;
    }
    if (pit) { if (e.outcome==='K' || e.outcome==='FO') pit.kp++; }
    if (e.errorById && ps[e.errorById]) ps[e.errorById].err++;
    (e.runsScoredBy||[]).forEach(pid => { if (ps[pid]) ps[pid].r++; });
  });
  const mx = fn => Math.max(0, ...allPids.map(id => fn(ps[id])));
  const mHit=mx(s=>s.hits), mRbi=mx(s=>s.rbi), mHr=mx(s=>s.hr),
        mR=mx(s=>s.r), mKp=mx(s=>s.kp), mBb=mx(s=>s.bb),
        mXbh=mx(s=>s.xbh), mErr=mx(s=>s.err);
  return allPids.map(pid => {
    const player = State.getPlayer(pid); if (!player) return null;
    const s = ps[pid];
    const c = [];
    if (s.hr>0  && s.hr===mHr)   c.push({ label:'Home Run Hero',   emoji:'🚀', detail:`${s.hr} HR` });
    if (s.rbi>0 && s.rbi===mRbi) c.push({ label:'RBI Machine',     emoji:'💥', detail:`${s.rbi} RBI` });
    if (s.hits>0&& s.hits===mHit) c.push({ label:'Hit Machine',    emoji:'⚾', detail:`${s.hits} H` });
    if (s.kp>0  && s.kp===mKp)   c.push({ label:'Strikeout King',  emoji:'🔥', detail:`${s.kp} K` });
    if (s.r>0   && s.r===mR)     c.push({ label:'Run Scorer',      emoji:'🏃', detail:`${s.r} R` });
    if (s.bb>0  && s.bb===mBb)   c.push({ label:'On-Base Machine', emoji:'🎯', detail:`${s.bb} BB` });
    if (s.xbh>0 && s.xbh===mXbh) c.push({ label:'Extra Bases',    emoji:'💪', detail:`${s.xbh} XBH` });
    if (s.err>0 && s.err===mErr) c.push({ label:'Tough Day',       emoji:'😬', detail:`${s.err} E` });
    const accolade = c[0] || (s.hits>0
      ? { label:'Solid Contact', emoji:'⭐', detail:`${s.hits} H` }
      : null);
    if (!accolade) return null;
    return { player, ...accolade };
  }).filter(Boolean);
}

function renderAccolades(g) {
  const list = computeGameAccolades(g);
  if (!list.length) return '';
  const cards = list.map(a => `
    <div class="accolade-card">
      <div class="accolade-emoji">${a.emoji}</div>
      <div class="accolade-label">${a.label}</div>
      <div class="accolade-name">${escapeHtml(a.player.name)}</div>
      ${a.detail ? `<div class="accolade-detail">${a.detail}</div>` : ''}
    </div>`).join('');
  return `<div class="accolades-section"><h3>Game Awards</h3><div class="accolades-row">${cards}</div></div>`;
}

/* ============================================================
   GAME RECAP / SHARE
   ============================================================ */
function buildRecapText(g) {
  const home = State.getTeam(g.homeTeamId);
  const away = State.getTeam(g.awayTeamId);
  const date = new Date(g.createdAt).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
  const winner = g.score.away > g.score.home ? away.name
               : g.score.home > g.score.away ? home.name : null;
  const lines = [];

  lines.push(`⚾ WiffleCast Game Recap — ${date}`);
  lines.push(`${away.name} @ ${home.name}`);
  lines.push('');
  lines.push(`FINAL: ${away.name} ${g.score.away}, ${home.name} ${g.score.home}${winner ? ` — ${winner} wins!` : ' — Tie'}`);
  lines.push('');

  // Line score
  const ls = g.lineScore || [];
  const innings = Math.max(g.numInnings, ls.length);
  const header = ['Inn', ...Array.from({length: innings}, (_, i) => String(i+1)), 'R'];
  const awayRow = [away.name, ...Array.from({length: innings}, (_, i) => {
    const e = ls.find(x => x.inning === i+1); return e != null ? String(e.top) : '-';
  }), String(g.score.away)];
  const homeRow = [home.name, ...Array.from({length: innings}, (_, i) => {
    const e = ls.find(x => x.inning === i+1); return e != null ? String(e.bottom) : '-';
  }), String(g.score.home)];
  const colW = header.map((_, ci) => Math.max(header[ci].length, awayRow[ci].length, homeRow[ci].length));
  const pad = (s, w) => s.padEnd(w);
  lines.push(header.map((h, i) => pad(h, colW[i])).join('  '));
  lines.push(awayRow.map((v, i) => pad(v, colW[i])).join('  '));
  lines.push(homeRow.map((v, i) => pad(v, colW[i])).join('  '));
  lines.push('');

  // Top performers
  const paEvents = (g.events||[]).filter(e => e.type === 'pa_end');
  const pids = [...new Set(paEvents.map(e => e.batterId).filter(Boolean))];
  const perf = pids.map(pid => {
    const p = State.getPlayer(pid); if (!p) return null;
    const evs = paEvents.filter(e => e.batterId === pid);
    const H = evs.filter(e => ['1B','2B','3B','HR'].includes(e.outcome)).length;
    const AB = evs.filter(e => !['BB'].includes(e.outcome)).length;
    const HR = evs.filter(e => e.outcome === 'HR').length;
    const RBI = evs.reduce((s, e) => s + (e.rbi||0), 0);
    const BB = evs.filter(e => e.outcome === 'BB').length;
    return { name: p.name, H, AB, HR, RBI, BB };
  }).filter(Boolean).filter(p => p.H > 0 || p.HR > 0 || p.RBI > 0);
  perf.sort((a, b) => (b.H + b.HR*2 + b.RBI) - (a.H + a.HR*2 + a.RBI));

  if (perf.length) {
    lines.push('TOP PERFORMERS');
    perf.slice(0, 5).forEach(p => {
      const parts = [];
      if (p.H)   parts.push(`${p.H}-for-${p.AB}`);
      if (p.HR)  parts.push(`${p.HR} HR`);
      if (p.RBI) parts.push(`${p.RBI} RBI`);
      if (p.BB)  parts.push(`${p.BB} BB`);
      lines.push(`  ${p.name}: ${parts.join(', ')}`);
    });
    lines.push('');
  }

  // Accolades
  const accolades = computeGameAccolades(g);
  if (accolades.length) {
    lines.push('AWARDS');
    accolades.forEach(a => lines.push(`  ${a.emoji} ${a.label}: ${a.player.name} (${a.detail})`));
    lines.push('');
  }

  lines.push('— Tracked with WiffleCast');
  return lines.join('\n');
}

/* Per-pitcher stats computed from game events (for recap email) */
function buildGamePitcherStats(g) {
  const paEvents = (g.events||[]).filter(e => e.type === 'pa_end' && e.pitcherId);
  const map = {};
  paEvents.forEach(e => {
    if (!map[e.pitcherId]) map[e.pitcherId] = { outs:0, H:0, K:0, FO:0, BB:0, BF:0 };
    const s = map[e.pitcherId];
    s.BF++;
    if (['1B','2B','3B','HR'].includes(e.outcome)) s.H++;
    if (e.outcome === 'K')        { s.K++;  s.outs++; }
    else if (e.outcome === 'FO')  { s.FO++; s.outs++; }
    else if (e.outcome === 'OUT') s.outs++;
    else if (e.outcome === 'BB')  s.BB++;
    // hits (1B/2B/3B/HR) are not outs
  });
  return Object.entries(map).map(([pid, s]) => {
    const p = State.getPlayer(pid);
    const full = Math.floor(s.outs / 3), rem = s.outs % 3;
    const ipStr = rem === 0 ? String(full) : `${full}.${rem}`;
    return { name: p?.name || '?', H: s.H, K: s.K, FO: s.FO, BB: s.BB, BF: s.BF, outs: s.outs, ipStr, ipVal: s.outs / 3 };
  }).sort((a, b) => b.ipVal - a.ipVal);
}

/* Build a nicely formatted HTML email recap */
function buildRecapHtml(g, recipientName) {
  const home = State.getTeam(g.homeTeamId);
  const away = State.getTeam(g.awayTeamId);
  if (!home || !away) return '<p>Game data unavailable.</p>';

  const esc = escapeHtml;
  const date = new Date(g.createdAt).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });

  const awayScore = g.score?.away ?? 0;
  const homeScore = g.score?.home ?? 0;
  const awayWon = awayScore > homeScore;
  const homeWon = homeScore > awayScore;

  // ── Line score ──────────────────────────────────────────────
  const ls = g.lineScore || [];
  const innings = Math.max(g.numInnings || 3, ls.length);
  const inns = Array.from({length: innings}, (_, i) => i + 1);
  const TH = t => `<td style="padding:5px 7px;text-align:center;font-size:11px;font-weight:700;color:#9ca3af;background:#f9fafb">${t}</td>`;
  const TD = t => `<td style="padding:5px 7px;text-align:center;font-size:12px;color:#374151;border-top:1px solid #f3f4f6">${t}</td>`;
  const lsTable = `
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden">
      <tr>
        <td style="padding:5px 8px;font-size:11px;font-weight:700;color:#9ca3af;background:#f9fafb"></td>
        ${inns.map(i => TH(i)).join('')}
        <td style="padding:5px 8px;text-align:center;font-size:11px;font-weight:700;color:#9ca3af;background:#f9fafb;border-left:1px solid #e5e7eb">R</td>
      </tr>
      <tr>
        <td style="padding:5px 8px;font-weight:700;font-size:12px;color:#111827">${esc(away.name)}</td>
        ${inns.map(i => { const e = ls.find(x => x.inning===i); return TD(e != null ? e.top : '–'); }).join('')}
        <td style="padding:5px 7px;text-align:center;font-size:13px;font-weight:800;color:${awayWon?'#15803d':'#374151'};border-top:1px solid #f3f4f6;border-left:1px solid #e5e7eb">${awayScore}</td>
      </tr>
      <tr>
        <td style="padding:5px 8px;font-weight:700;font-size:12px;color:#111827;border-top:1px solid #f3f4f6">${esc(home.name)}</td>
        ${inns.map(i => { const e = ls.find(x => x.inning===i); return TD(e != null ? e.bottom : '–'); }).join('')}
        <td style="padding:5px 7px;text-align:center;font-size:13px;font-weight:800;color:${homeWon?'#15803d':'#374151'};border-top:1px solid #f3f4f6;border-left:1px solid #e5e7eb">${homeScore}</td>
      </tr>
    </table>`;

  // ── Top Performers (batting) ─────────────────────────────────
  const paEvents = (g.events||[]).filter(e => e.type === 'pa_end');
  const pids = [...new Set(paEvents.map(e => e.batterId).filter(Boolean))];
  const batters = pids.map(pid => {
    const p = State.getPlayer(pid); if (!p) return null;
    const evs = paEvents.filter(e => e.batterId === pid);
    const H = evs.filter(e => ['1B','2B','3B','HR'].includes(e.outcome)).length;
    const AB = evs.filter(e => e.outcome !== 'BB').length;
    const HR = evs.filter(e => e.outcome === 'HR').length;
    const RBI = evs.reduce((s, e) => s + (e.rbi||0), 0);
    const BB = evs.filter(e => e.outcome === 'BB').length;
    const K  = evs.filter(e => e.outcome === 'K').length;
    const FO = evs.filter(e => e.outcome === 'FO').length;
    return { name: p.name, H, AB, HR, RBI, BB, K, FO };
  }).filter(Boolean).filter(p => p.H > 0 || p.HR > 0 || p.RBI > 0);
  batters.sort((a, b) => (b.H + b.HR*2 + b.RBI) - (a.H + a.HR*2 + a.RBI));

  const SSTATTH = t => `<th style="padding:6px 10px;font-size:11px;font-weight:700;color:#9ca3af;text-align:center;background:#f3f4f6;white-space:nowrap">${t}</th>`;
  const SSTATTD = (t, bold, color) => `<td style="padding:6px 10px;font-size:12px;text-align:center;color:${color||'#374151'};font-weight:${bold?700:400};white-space:nowrap">${t}</td>`;

  let battingSection = '';
  if (batters.length) {
    const rows = batters.slice(0, 6).map((b, i) => `
      <tr style="background:${i%2?'#ffffff':'#f9fafb'}">
        <td style="padding:6px 10px;font-size:13px;font-weight:700;color:#111827">${esc(b.name)}</td>
        ${SSTATTD(`${b.H}-for-${b.AB}`, true, b.H>0?'#15803d':'#374151')}
        ${SSTATTD(b.HR||'–', b.HR>0, b.HR>0?'#7c3aed':'#374151')}
        ${SSTATTD(b.RBI||'–', b.RBI>0)}
        ${SSTATTD(b.BB||'–')}
        ${SSTATTD(b.K||'–')}
        ${SSTATTD(b.FO||'–')}
      </tr>`).join('');
    battingSection = `
      <tr><td style="padding:0 24px 20px">
        <div style="font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px">Top Performers</div>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden">
          <thead><tr style="background:#f3f4f6">
            <th style="padding:6px 10px;font-size:11px;font-weight:700;color:#9ca3af;text-align:left;background:#f3f4f6">Player</th>
            ${SSTATTH('H/AB')}${SSTATTH('HR')}${SSTATTH('RBI')}${SSTATTH('BB')}${SSTATTH('K')}${SSTATTH('FO')}
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </td></tr>`;
  }

  // ── Pitching Highlights ──────────────────────────────────────
  const pitchers = buildGamePitcherStats(g);
  let pitchingSection = '';
  if (pitchers.length) {
    const rows = pitchers.map((p, i) => `
      <tr style="background:${i%2?'#ffffff':'#f9fafb'}">
        <td style="padding:6px 10px;font-size:13px;font-weight:700;color:#111827">${esc(p.name)}</td>
        ${SSTATTD(p.ipStr, true)}
        ${SSTATTD(p.K||'–', p.K>0, p.K>0?'#dc2626':'#374151')}
        ${SSTATTD(p.FO||'–', p.FO>0, p.FO>0?'#dc2626':'#374151')}
        ${SSTATTD(p.BB||'–')}
        ${SSTATTD(p.H||'–')}
      </tr>`).join('');
    pitchingSection = `
      <tr><td style="padding:0 24px 20px">
        <div style="font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px">Pitching</div>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden">
          <thead><tr style="background:#f3f4f6">
            <th style="padding:6px 10px;font-size:11px;font-weight:700;color:#9ca3af;text-align:left;background:#f3f4f6">Pitcher</th>
            ${SSTATTH('IP')}${SSTATTH('K')}${SSTATTH('FO')}${SSTATTH('BB')}${SSTATTH('H')}
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </td></tr>`;
  }

  // ── Game Awards ──────────────────────────────────────────────
  const accolades = computeGameAccolades(g);
  let awardsSection = '';
  if (accolades.length) {
    const perRow = Math.min(accolades.length, 4);
    const pct = Math.floor(100 / perRow);
    const cards = accolades.slice(0, 8).map(a => `
      <td width="${pct}%" align="center" valign="top" style="padding:4px">
        <div style="background:#f0fdf4;border:1px solid #dcfce7;border-radius:8px;padding:12px 6px;text-align:center">
          <div style="font-size:22px;line-height:1;margin-bottom:4px">${a.emoji}</div>
          <div style="font-size:10px;font-weight:700;color:#15803d;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:3px">${esc(a.label)}</div>
          <div style="font-size:12px;font-weight:700;color:#111827">${esc(a.player.name)}</div>
          <div style="font-size:11px;color:#6b7280;margin-top:2px">${a.detail||''}</div>
        </div>
      </td>`).join('');
    awardsSection = `
      <tr><td style="padding:0 24px 20px">
        <div style="font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px">Game Awards</div>
        <table width="100%" cellpadding="0" cellspacing="0"><tr>${cards}</tr></table>
      </td></tr>`;
  }

  const greeting = recipientName
    ? `<tr><td style="padding:20px 24px 4px;font-size:14px;color:#374151">Hi <strong>${esc(recipientName)}</strong>, here's your game recap.</td></tr>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WiffleCast Game Recap</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 0">
<tr><td align="center" style="padding:0 12px">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;width:100%;max-width:600px;border:1px solid #e5e7eb">

  <!-- HEADER -->
  <tr><td style="background:#14532d;padding:28px 24px;text-align:center">
    <div style="font-size:36px;line-height:1;margin-bottom:8px">⚾</div>
    <div style="color:#ffffff;font-size:20px;font-weight:700">WiffleCast Game Recap</div>
    <div style="color:#86efac;font-size:13px;margin-top:6px">${date}</div>
  </td></tr>

  ${greeting}

  <!-- SCORE BANNER -->
  <tr><td style="background:#f0fdf4;padding:28px 16px;border-bottom:2px solid #dcfce7">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td width="43%" align="center" valign="top" style="padding:0 8px">
          <div style="font-size:14px;font-weight:700;color:#15803d;margin-bottom:8px;line-height:1.2">${esc(away.name)}</div>
          <div style="font-size:52px;font-weight:800;line-height:1;color:${awayWon?'#15803d':'#9ca3af'}">${awayScore}</div>
          <div style="margin-top:8px;min-height:22px">${awayWon?'<span style="display:inline-block;background:#15803d;color:#fff;font-size:10px;font-weight:700;padding:3px 10px;border-radius:12px;letter-spacing:0.07em">WINNER</span>':''}</div>
        </td>
        <td width="14%" align="center" valign="top" style="padding-top:18px">
          <div style="font-size:18px;color:#d1d5db">@</div>
        </td>
        <td width="43%" align="center" valign="top" style="padding:0 8px">
          <div style="font-size:14px;font-weight:700;color:#15803d;margin-bottom:8px;line-height:1.2">${esc(home.name)}</div>
          <div style="font-size:52px;font-weight:800;line-height:1;color:${homeWon?'#15803d':'#9ca3af'}">${homeScore}</div>
          <div style="margin-top:8px;min-height:22px">${homeWon?'<span style="display:inline-block;background:#15803d;color:#fff;font-size:10px;font-weight:700;padding:3px 10px;border-radius:12px;letter-spacing:0.07em">WINNER</span>':''}</div>
        </td>
      </tr>
    </table>
  </td></tr>

  <!-- LINE SCORE -->
  <tr><td style="padding:20px 24px">
    <div style="font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px">Line Score</div>
    ${lsTable}
  </td></tr>

  ${battingSection}
  ${pitchingSection}
  ${awardsSection}

  <!-- FOOTER -->
  <tr><td style="background:#f9fafb;padding:16px 24px;text-align:center;border-top:1px solid #e5e7eb">
    <div style="font-size:12px;color:#9ca3af">Tracked with <strong style="color:#6b7280">WiffleCast</strong></div>
    <div style="margin-top:8px">
      <a href="${window.location.origin}${window.location.pathname}?game=${g.id}" style="font-size:12px;color:#15803d;text-decoration:none;font-weight:600">View this game ↗</a>
    </div>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

