/* ============================================================
   RENDER LAYER
   ============================================================ */
const fmt = {
  avg(n) { return n ? n.toFixed(3).replace(/^0/, '') : '.000'; },
  ip(n) {
    const whole = Math.floor(n);
    const frac = Math.round((n - whole) * 3);
    return whole + (frac ? '.' + frac : '.0');
  },
};

// ── Column definitions — shared by stats tables and single-row home page display ──
// Normalized keys used by both player and team renderers.
// Player data is mapped to these keys via normalizePlayerBatting/Pitching/Fielding.
const BATTING_COLS = [
  { key: 'GP',  label: 'GP'  },
  { key: 'PA',  label: 'PA'  },
  { key: 'AB',  label: 'AB'  },
  { key: 'AVG', label: 'AVG', fmt: v => fmt.avg(v) },
  { key: 'OBP', label: 'OBP', fmt: v => fmt.avg(v) },
  { key: 'SLG', label: 'SLG', fmt: v => fmt.avg(v) },
  { key: 'H',   label: 'H'   },
  { key: '1B',  label: '1B'  },
  { key: '2B',  label: '2B'  },
  { key: '3B',  label: '3B'  },
  { key: 'HR',  label: 'HR'  },
  { key: 'R',   label: 'R'   },
  { key: 'RBI', label: 'RBI' },
  { key: 'BB',  label: 'BB'  },
  { key: 'K',   label: 'K'   },
];
const PITCH_COLS = [
  { key: 'GP',     label: 'GP'     },
  { key: 'IP',     label: 'IP',     fmt: v => fmt.ip(v) },
  { key: 'ERA',    label: 'ERA',    fmt: v => v !== null ? v.toFixed(2) : '—', nullLow: true },
  { key: 'K',      label: 'K'      },
  { key: 'BB',     label: 'BB'     },
  { key: 'H',      label: 'H'      },
  { key: 'R',      label: 'R'      },
  { key: 'ER',     label: 'ER'     },
  { key: 'WHIP',   label: 'WHIP',  fmt: v => v !== null ? v.toFixed(2) : '—', nullLow: true },
  { key: 'pPerIP', label: 'P/IP',  fmt: v => v !== null ? v.toFixed(1) : '—' },
  { key: 'pPerBF', label: 'P/BP',  fmt: v => v !== null ? v.toFixed(2) : '—' },
  { key: 'sPct',   label: 'S%',    fmt: v => v !== null ? (v * 100).toFixed(1) + '%' : '—' },
  { key: 'kPerBF', label: 'K/BP',  fmt: v => v !== null ? v.toFixed(3) : '—' },
  { key: 'kPerInn',label: 'K/Inn', fmt: v => v !== null ? v.toFixed(2) : '—' },
  { key: 'bbPerInn',label:'BB/Inn',fmt: v => v !== null ? v.toFixed(2) : '—' },
];
const FIELD_COLS = [
  { key: 'GP',         label: 'GP' },
  { key: 'PO',         label: 'PO' },
  { key: 'E',          label: 'E'  },
  { key: 'dpAttempts', label: 'DPA' },
  { key: 'dpSuccesses',label: 'DP'  },
  { key: 'dpPct',      label: 'DP%', fmt: v => v !== null ? (v * 100).toFixed(0) + '%' : '—' },
  { key: 'tagAttempts',label: 'TAGA' },
  { key: 'tagSuccesses',label:'TAG'  },
  { key: 'tagPct',     label: 'TAG%', fmt: v => v !== null ? (v * 100).toFixed(0) + '%' : '—' },
];
const TEAM_RECORD_COLS = [
  { key: 'GP', label: 'GP' },
  { key: 'W',  label: 'W'  },
  { key: 'L',  label: 'L'  },
  { key: 'RF', label: 'RF' },
  { key: 'RA', label: 'RA' },
];

// ── Normalize raw computePlayerStats result to unified column keys ──
function playerBattingData(s) {
  return { GP: s.GP, PA: s.PA, AB: s.AB, AVG: s.AVG, OBP: s.OBP, SLG: s.SLG, H: s.H,
    '1B': s.singles, '2B': s.doubles, '3B': s.triples, HR: s.hrs,
    R: s.R, RBI: s.RBI, BB: s.BB, K: s.K_bat };
}
function playerPitchingData(s) {
  return { GP: s.pGP, IP: s.IP, ERA: s.ERA, K: s.pK, BB: s.pBB, H: s.pH, R: s.pR, ER: s.pER,
    WHIP: s.pWHIP, pPerIP: s.pPerIP, pPerBF: s.pPerBF, sPct: s.pSPct,
    kPerBF: s.pKPerBF, kPerInn: s.pKPerInn, bbPerInn: s.pBBPerInn };
}
function playerFieldingData(s) {
  return { GP: s.fGP, PO: s.PO, E: s.E,
    dpAttempts: s.dpAttempts, dpSuccesses: s.dpSuccesses, dpPct: s.dpPct,
    tagAttempts: s.tagAttempts, tagSuccesses: s.tagSuccesses, tagPct: s.tagPct };
}
function teamBattingData(bs, gp = 0) {
  return { GP: gp, PA: bs.PA, AB: bs.AB, AVG: bs.AVG, OBP: bs.OBP, SLG: bs.SLG, H: bs.H,
    '1B': bs.singles, '2B': bs.doubles, '3B': bs.triples, HR: bs.hrs,
    R: bs.R, RBI: bs.RBI, BB: bs.BB, K: bs.K };
}
function teamPitchingData(ps, gp = 0) {
  return { GP: gp, IP: ps.IP, ERA: ps.ERA, K: ps.K, BB: ps.BB, H: ps.H, R: ps.R, ER: ps.ER,
    WHIP: ps.WHIP, pPerIP: ps.pPerIP, pPerBF: ps.pPerBF, sPct: ps.sPct,
    kPerBF: ps.kPerBF, kPerInn: ps.kPerInn, bbPerInn: ps.bbPerInn };
}

// ── Shared stat tile/grid primitives ────────────────────────
function statTile(label, value, hi) {
  return `<div class="stat-lg${hi ? ' hi' : ''}"><div class="stat-label">${label}</div><div class="stat-value">${value}</div></div>`;
}

// ── Shared stat grid primitives ─────────────────────────────
// Row functions return ONLY the tile grid (no label).
// Callers that need section labels (home page, modal) add them via
// renderPlayerStatRows / renderTeamStatRows.
// The stats-tab detail uses the raw row functions inside its own tabs.

function renderPlayerBattingRow(s) {
  return `<div class="stat-row-lg">
    ${statTile('AVG', fmt.avg(s.AVG), true)}
    ${statTile('SLG', fmt.avg(s.SLG), true)}
    ${statTile('PA', s.PA)}
    ${statTile('AB', s.AB)}
    ${statTile('H', s.H)}
    ${statTile('1B', s.singles)}
    ${statTile('2B', s.doubles)}
    ${statTile('3B', s.triples)}
    ${statTile('HR', s.hrs)}
    ${statTile('R', s.R)}
    ${statTile('RBI', s.RBI)}
    ${statTile('BB', s.BB)}
    ${statTile('K', s.K_bat)}
    ${statTile('KL', s.K_looking)}
    ${statTile('KS', s.K_swinging)}
    ${statTile('KF', s.K_foul)}
  </div>`;
}

function renderPlayerPitchingRow(s) {
  return `<div class="stat-row-lg">
    ${statTile('ERA', s.ERA !== null ? s.ERA.toFixed(2) : '—', true)}
    ${statTile('IP', fmt.ip(s.IP), true)}
    ${statTile('GP', s.pGP)}
    ${statTile('K', s.pK)}
    ${statTile('KL', s.pKL)}
    ${statTile('KS', s.pKS)}
    ${statTile('KF', s.pKF)}
    ${statTile('BB', s.pBB)}
    ${statTile('ER', s.pER)}
  </div>`;
}

function renderPlayerFieldingRow(s) {
  const dpPctStr  = s.dpPct  !== null && s.dpPct  !== undefined ? (s.dpPct  * 100).toFixed(0) + '%' : '—';
  const tagPctStr = s.tagPct !== null && s.tagPct !== undefined ? (s.tagPct * 100).toFixed(0) + '%' : '—';
  return `<div class="stat-row-lg">
    ${statTile('PO', s.PO)}
    ${statTile('E', s.E)}
    ${statTile('DPA', s.dpAttempts || 0)}
    ${statTile('DP', s.dpSuccesses || 0)}
    ${statTile('DP%', dpPctStr)}
    ${statTile('TAGA', s.tagAttempts || 0)}
    ${statTile('TAG', s.tagSuccesses || 0)}
    ${statTile('TAG%', tagPctStr)}
  </div>`;
}

// All three sections with labels — for home page card and player modal
function renderPlayerStatRows(s) {
  return `
    <div class="stat-section-title" style="margin-top:0">Batting</div>
    ${renderPlayerBattingRow(s)}
    <div class="stat-section-title">Pitching</div>
    ${renderPlayerPitchingRow(s)}
    <div class="stat-section-title">Fielding</div>
    ${renderPlayerFieldingRow(s)}`;
}

function renderTeamBattingRow(bat) {
  return `<div class="stat-row-lg">
    ${statTile('AVG', fmt.avg(bat.AVG), true)}
    ${statTile('SLG', fmt.avg(bat.SLG), true)}
    ${statTile('AB', bat.AB)}
    ${statTile('H', bat.H)}
    ${statTile('HR', bat.hrs)}
    ${statTile('R', bat.R)}
    ${statTile('RBI', bat.RBI)}
    ${statTile('BB', bat.BB)}
    ${statTile('K', bat.K)}
  </div>`;
}

function renderTeamPitchingRow(pit) {
  return `<div class="stat-row-lg">
    ${statTile('ERA', pit.ERA !== null ? pit.ERA.toFixed(2) : '—', true)}
    ${statTile('IP', fmt.ip(pit.IP), true)}
    ${statTile('K', pit.K)}
    ${statTile('BB', pit.BB)}
    ${statTile('ER', pit.ER)}
    ${statTile('H', pit.H)}
  </div>`;
}

// Both team sections with labels — for home page card
function renderTeamStatRows(teamId) {
  const bat = State.computeTeamBattingStats(teamId);
  const pit = State.computeTeamPitchingStats(teamId);
  return `
    <div class="stat-section-title" style="margin-top:0">Batting</div>
    ${renderTeamBattingRow(bat)}
    <div class="stat-section-title">Pitching</div>
    ${renderTeamPitchingRow(pit)}`;
}

// ── Single-row stats table helpers (home page + modal) ──────
// Renders column headers + one data row using the same stats-table styling.
// No name column — the caller provides context (card heading, modal title).
function renderStatTableRow(cols, data) {
  const ths = cols.map(c => `<th class="num-col">${c.label}</th>`).join('');
  const tds = cols.map(c => {
    const v = data[c.key];
    return `<td>${c.fmt ? c.fmt(v) : (v ?? '—')}</td>`;
  }).join('');
  return `<div class="stats-table-wrap" style="-webkit-overflow-scrolling:touch"><table class="stats-table stats-table--noname" style="width:auto">
    <thead><tr>${ths}</tr></thead>
    <tbody><tr>${tds}</tr></tbody>
  </table></div>`;
}

function renderPlayerStatTable(s) {
  return `
    <div class="stat-section-title" style="margin-top:0">Batting</div>
    ${renderStatTableRow(BATTING_COLS, playerBattingData(s))}
    <div class="stat-section-title">Pitching</div>
    ${renderStatTableRow(PITCH_COLS, playerPitchingData(s))}
    <div class="stat-section-title">Fielding</div>
    ${renderStatTableRow(FIELD_COLS, playerFieldingData(s))}`;
}

function renderTeamStatTable(teamId) {
  const ts  = State.computeTeamStats(teamId);
  const bat = State.computeTeamBattingStats(teamId);
  const pit = State.computeTeamPitchingStats(teamId);
  const fld = State.computeTeamFieldingStats(teamId);
  const recData = { GP: ts.gamesPlayed, W: ts.wins, L: ts.losses,
    RF: ts.runsFor, RA: ts.runsAgainst };
  return `
    <div class="stat-section-title" style="margin-top:0">Record</div>
    ${renderStatTableRow(TEAM_RECORD_COLS, recData)}
    <div class="stat-section-title">Batting</div>
    ${renderStatTableRow(BATTING_COLS, teamBattingData(bat, ts.gamesPlayed))}
    <div class="stat-section-title">Pitching</div>
    ${renderStatTableRow(PITCH_COLS, teamPitchingData(pit, ts.gamesPlayed))}
    <div class="stat-section-title">Fielding</div>
    ${renderStatTableRow(FIELD_COLS, fld)}`;
}

// Shared helper: renders one section table (one row per team) for the home page.
function renderHomeTeamsSection(teams, view) {
  if (!teams.length) return '<p style="color:#6b7280;font-size:14px;margin:0">No teams yet.</p>';

  const teamData = teams.map(t => {
    const ts  = State.computeTeamStats(t.id);
    const bat = State.computeTeamBattingStats(t.id);
    const pit = State.computeTeamPitchingStats(t.id);
    const fld = State.computeTeamFieldingStats(t.id);
    return { t,
      record:   { GP: ts.gamesPlayed, W: ts.wins, L: ts.losses, RF: ts.runsFor, RA: ts.runsAgainst },
      batting:  teamBattingData(bat, ts.gamesPlayed),
      pitching: teamPitchingData(pit, ts.gamesPlayed),
      fielding: fld,
    };
  });

  const colsMap = { record: TEAM_RECORD_COLS, batting: BATTING_COLS, pitching: PITCH_COLS, fielding: FIELD_COLS };
  const cols = colsMap[view] || TEAM_RECORD_COLS;
  const sort = homeTeamSort[view];

  // Sort rows
  teamData.sort((a, b) => {
    if (sort.col === 'name') return b.t.name.localeCompare(a.t.name) * sort.dir;
    let av = a[view][sort.col] ?? null, bv = b[view][sort.col] ?? null;
    if (av === null) av = sort.dir > 0 ? Infinity : -Infinity;
    if (bv === null) bv = sort.dir > 0 ? Infinity : -Infinity;
    return (bv - av) * sort.dir;
  });

  const thArr = c => {
    const isSorted = sort.col === c.key;
    const arr = isSorted ? (sort.dir === -1 ? '▼' : '▲') : '<span style="opacity:0.25">▼</span>';
    return `<th class="num-col ${isSorted ? 'sorted' : ''}" onclick="sortHomeTeams('${c.key}','${view}')">${c.label}<span class="sort-arr">${arr}</span></th>`;
  };
  const nameSortArr = sort.col === 'name'
    ? (sort.dir === -1 ? '<span class="sort-arr">▼</span>' : '<span class="sort-arr">▲</span>')
    : '<span class="sort-arr" style="opacity:0.25">▼</span>';

  const trs = teamData.map(row => {
    const d = row[view];
    const tds = cols.map(c => `<td>${c.fmt ? c.fmt(d[c.key]) : (d[c.key] ?? '—')}</td>`).join('');
    return `<tr style="cursor:pointer" onclick="showTeamStatsModal('${row.t.id}')"><td>${escapeHtml(row.t.name)}</td>${tds}</tr>`;
  }).join('');
  return `<div class="stats-table-wrap"><table class="stats-table">
    <thead><tr><th onclick="sortHomeTeams('name','${view}')">Team${nameSortArr}</th>${cols.map(thArr).join('')}</tr></thead>
    <tbody>${trs}</tbody>
  </table></div>`;
}

function showPlayerStatsModal(playerId) {
  const p = State.getPlayer(playerId); if (!p) return;
  const s = State.computePlayerStats(playerId);
  const name = p.jerseyNumber ? `#${p.jerseyNumber} ${p.name}` : p.name;
  const canEdit = isAdmin() || currentUserProfile?.playerId === playerId;
  const editBtn = canEdit
    ? `<button class="btn btn-sm" onclick="Modal.hide();showPlayerModal('${playerId}')" style="margin-right:8px">✎ Edit</button>`
    : '';
  Modal.show(`
    <div class="modal-header">
      <h3>${escapeHtml(name)}</h3>
      <button class="btn-icon" onclick="Modal.hide()">✕</button>
    </div>
    <div class="modal-body">
      ${renderPlayerStatTable(s)}
    </div>
    <div class="modal-footer">
      ${editBtn}
      <button class="btn" onclick="Modal.hide()">Close</button>
    </div>`);
}

function showTeamStatsModal(teamId) {
  const t = State.getTeam(teamId); if (!t) return;
  const myPid = currentUserProfile?.playerId;
  const isMember = myPid && (t.playerIds || []).includes(myPid);
  const canEdit = isAdmin() || isMember;

  // Roster list
  const rosterHtml = (t.playerIds || []).length
    ? (t.playerIds
        .map(pid => State.getPlayer(pid))
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(p => {
          const num = p.jerseyNumber ? `<span class="jersey-badge" style="width:22px;height:22px;font-size:11px;margin-right:6px">${escapeHtml(p.jerseyNumber)}</span>` : '';
          return `<span style="display:inline-flex;align-items:center;margin:3px 6px 3px 0;font-size:13px">${num}${escapeHtml(p.name)}</span>`;
        })
        .join(''))
    : '<span style="color:#6b7280;font-size:13px">No players</span>';

  const teamColor = _teamColor(t);
  const colorDot = `<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${teamColor};margin-right:6px;vertical-align:middle;border:1px solid rgba(0,0,0,0.15)"></span>`;

  const editBtn = canEdit
    ? `<button class="btn btn-sm" onclick="Modal.hide();showTeamModal('${teamId}')" style="margin-right:8px">✎ Edit</button>`
    : '';

  Modal.show(`
    <div class="modal-header">
      <h3>${colorDot}${escapeHtml(t.name)}</h3>
      <button class="btn-icon" onclick="Modal.hide()">✕</button>
    </div>
    <div class="modal-body">
      <div style="margin-bottom:12px">
        <div class="stat-section-title" style="margin-top:0">Roster</div>
        <div style="line-height:1.8">${rosterHtml}</div>
      </div>
      ${renderTeamStatTable(teamId)}
    </div>
    <div class="modal-footer">
      ${editBtn}
      <button class="btn" onclick="Modal.hide()">Close</button>
    </div>`);
}

/* ============================================================
   AUTH
   ============================================================ */
const ADMIN_EMAIL = 'rubix222@gmail.com';
let currentUser = null;
let currentUserProfile = null;
let adminFeaturesEnabled = localStorage.getItem('wc_admin_features') !== 'false';
function isAdminUser() { return currentUser?.email === ADMIN_EMAIL; }
function isAdmin() { return isAdminUser() && adminFeaturesEnabled; }

function toggleAdminFeatures() {
  adminFeaturesEnabled = !adminFeaturesEnabled;
  localStorage.setItem('wc_admin_features', String(adminFeaturesEnabled));
  updateAuthUI();
  Render.all();
}
function canUserScore() { return isAdmin() || (currentUser && currentUserProfile?.canScore); }


let _currentTab = 'home';  // tracks active tab for back-navigation after live game

// Home tab card view state
let homePlayerView = 'batting'; // 'batting' | 'pitching' | 'fielding'
let homeTeamsView  = 'record';  // 'record' | 'batting' | 'pitching' | 'fielding'
const homeTeamSort = {
  record:   { col: 'W',   dir: -1 },
  batting:  { col: 'AVG', dir: -1 },
  pitching: { col: 'ERA', dir:  1 },
  fielding: { col: 'PO',  dir: -1 },
};

// Player view state
let selectedPlayerId = null;
let playersView    = 'batting';  // 'batting' | 'pitching' | 'fielding'

// Team view state
let selectedTeamId = null;

// Game view state
let selectedGameId = null;
let showFinishedGames = false;
let showMyGamesOnly = true;
let statsSort    = { col: 'AVG', dir: -1 };
let pitchSort    = { col: 'ERA', dir:  1 };
let fieldSort    = { col: 'PO',  dir: -1 };
let teamBatSort    = { col: 'AVG', dir: -1 };
let teamPitSort    = { col: 'ERA', dir:  1 };
let teamFieldSort  = { col: 'PO', dir: -1 };
let teamRecordSort = { col: 'W',  dir: -1 };
let teamsView      = 'record'; // 'record' | 'batting' | 'pitching' | 'fielding'

// ---- Stats event filter ----
// null = all events/games; Set = explicit selection of tournament IDs + '__none__'
let statsEventFilter  = null; // null = all events; Set<key> = subset
let _statsFilterDraft = null; // pending state while filter modal is open

// ---- Tournament-detail stats view state ----
let _tournStatsView = 'batting'; // 'batting' | 'pitching' | 'fielding'
let _tournTeamView  = 'batting'; // 'batting' | 'pitching'
// Sort state — separate from main stats so the two views are independent
let _tpSort  = { col: 'AVG', dir: -1 }; // tournament player batting
let _tppSort = { col: 'ERA', dir:  1 }; // tournament player pitching
let _tpfSort = { col: 'PO',  dir: -1 }; // tournament player fielding
let _ttbSort = { col: 'AVG', dir: -1 }; // tournament team batting
let _ttpSort = { col: 'ERA', dir:  1 }; // tournament team pitching

function setPlayersView(view) {
  playersView = view;
  $$('#players-subnav button').forEach(b => b.classList.toggle('active', b.dataset.pview === view));
  Render.players();
}
function selectPlayer(id) {
  selectedPlayerId = id;
  Render.players();
}
function selectTeam(id) {
  selectedTeamId = id;
  Render.teams();
}
function setStatsMain(view) {
  // Both sections always visible — kept for compatibility with home page links
}
function setTeamsView(view) {
  teamsView = view;
  $$('#teams-subnav button').forEach(b => b.classList.toggle('active', b.dataset.tview === view));
  Render.teams();
}
function setHomePlayerView(view) { homePlayerView = view; Render.home(); }
function setHomeTeamsView(view)  { homeTeamsView  = view; Render.home(); }
function sortHomeTeams(col, view) {
  const s = homeTeamSort[view];
  s.dir = s.col === col ? -s.dir : -1;
  s.col = col;
  Render.home();
}

function sortTeamStats(col, which) {
  const s = which === 'pitching' ? teamPitSort
          : which === 'fielding' ? teamFieldSort
          : which === 'record'   ? teamRecordSort
          : teamBatSort;
  s.dir = s.col === col ? -s.dir : -1;
  s.col = col;
  Render.teams();
}
function sortStats(col, which) {
  const s = which === 'pitching' ? pitchSort : which === 'fielding' ? fieldSort : statsSort;
  s.dir = s.col === col ? -s.dir : -1;
  s.col = col;
  Render.players();
}
function showCreateMyPlayerModal() {
  Modal.show(`
    <div class="modal-header">
      <h3>Create My Player</h3>
      <button class="btn-icon" onclick="Modal.hide()">✕</button>
    </div>
    <form onsubmit="submitMyPlayer(event)">
      <div class="modal-body">
        <div class="form-group">
          <label for="my-player-name">Name</label>
          <input id="my-player-name" required autofocus value="${escapeHtml(currentUserProfile?.name || currentUser?.email?.split('@')[0] || '')}" />
        </div>
        <div class="form-group">
          <label for="my-player-jersey">Jersey number <span class="muted small">(optional)</span></label>
          <input id="my-player-jersey" maxlength="4" />
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn" onclick="Modal.hide()">Cancel</button>
        <button type="submit" class="btn btn-primary">Create</button>
      </div>
    </form>`);
}
async function submitMyPlayer(e) {
  e.preventDefault();
  if (!currentUser) return;
  const name = $('#my-player-name').value.trim();
  const jersey = $('#my-player-jersey').value.trim();
  if (!name) return;
  const p = await State.addPlayer({ name, jerseyNumber: jersey });
  p.userId = currentUser.uid;
  p.invitePending = false;
  await Storage.savePlayer(p);
  // Link profile
  if (currentUserProfile) {
    currentUserProfile.playerId = p.id;
    await Storage.saveUser(currentUserProfile);
  } else {
    currentUserProfile = { uid: currentUser.uid, email: currentUser.email, name, playerId: p.id, createdAt: Date.now() };
    await Storage.saveUser(currentUserProfile);
  }
  Modal.hide();
  selectedPlayerId = p.id;
  Render.all();
  toast('Player created!', 'success');
}

function updateAuthUI() {
  const btnIn      = $('#btn-sign-in');
  const menuWrap   = $('#user-menu-wrap');
  const nameEl     = $('#auth-user-name');
  if (!btnIn) return;

  if (currentUser) {
    btnIn.style.display    = 'none';
    menuWrap.style.display = '';
    nameEl.textContent     = currentUserProfile?.name || currentUser.email.split('@')[0];
  } else {
    btnIn.style.display    = '';
    menuWrap.style.display = 'none';
  }

  // Add-team / add-game buttons — admin only
  const addTeam = $('#btn-add-team');
  const addGame = $('#btn-add-game');
  if (addTeam) addTeam.style.display = isAdmin() ? '' : 'none';
  if (addGame) addGame.style.display = isAdmin() ? '' : 'none';

  // Admin tab — admin only
  $$('.admin-only-tab').forEach(t => { t.style.display = isAdminUser() ? '' : 'none'; });
}

function toggleUserMenu() {
  const dd = $('#user-menu-dropdown');
  if (!dd) return;
  const open = dd.style.display !== 'none';
  dd.style.display = open ? 'none' : '';
}
function closeUserMenu() {
  const dd = $('#user-menu-dropdown');
  if (dd) dd.style.display = 'none';
}

async function createOrLinkUserProfile(user, playerId, name) {
  const existing = await Storage.getUser(user.uid);
  if (existing) { currentUserProfile = existing; return; }
  const profile = {
    uid: user.uid,
    email: user.email,
    name: name || user.displayName || user.email.split('@')[0],
    playerId: playerId || null,
    createdAt: Date.now(),
  };
  await Storage.saveUser(profile);
  currentUserProfile = profile;
  if (playerId) {
    const player = State.getPlayer(playerId);
    if (player) {
      player.userId = user.uid;
      player.invitePending = false;
      await Storage.savePlayer(player);
    }
  }
}

function authErrorMessage(code) {
  return ({
    'auth/user-not-found':      'No account found with that email.',
    'auth/wrong-password':      'Incorrect password.',
    'auth/invalid-credential':  'Incorrect email or password.',
    'auth/email-already-in-use':'An account with that email already exists.',
    'auth/weak-password':       'Password must be at least 6 characters.',
    'auth/invalid-email':       'Invalid email address.',
    'auth/too-many-requests':   'Too many attempts. Please try again later.',
  })[code] || 'Authentication failed. Please try again.';
}

function showAuthModal(mode = 'signin', errorMsg = '') {
  Modal.show(`
    <div class="modal-header">
      <h3>${mode === 'signin' ? 'Sign In' : 'Create Account'}</h3>
      <button class="btn-icon" onclick="Modal.hide()">✕</button>
    </div>
    <div class="modal-body">
      ${errorMsg ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:8px 12px;color:#b91c1c;font-size:13px;margin-bottom:12px">${escapeHtml(errorMsg)}</div>` : ''}
      <div id="google-btn-container" style="margin-bottom:4px;min-height:44px"></div>
      <button type="button" style="display:none">
        <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#4285F4" d="M44.5 20H24v8.5h11.7C34.2 33.6 29.6 37 24 37c-7.2 0-13-5.8-13-13s5.8-13 13-13c3.1 0 6 1.1 8.2 3l6-6C34.5 5.1 29.5 3 24 3 12.4 3 3 12.4 3 24s9.4 21 21 21c10.8 0 20-7.8 20-21 0-1.4-.1-2.7-.5-4z"/><path fill="#34A853" d="M6.3 14.7l7 5.1C15 16.1 19.1 13 24 13c3.1 0 6 1.1 8.2 3l6-6C34.5 5.1 29.5 3 24 3c-7.6 0-14.2 4.6-17.7 11.7z"/><path fill="#FBBC05" d="M24 45c5.4 0 10.3-1.8 14.1-4.9l-6.5-5.4C29.6 36.4 26.9 37 24 37c-5.6 0-10.2-3.4-11.7-8.3l-7 5.4C8.9 41 15.9 45 24 45z"/><path fill="#EA4335" d="M44.5 20H24v8.5h11.7c-.8 2.3-2.3 4.2-4.2 5.6l6.5 5.4C42 36.2 45 30.6 45 24c0-1.4-.1-2.7-.5-4z"/></svg>
        Continue with Google
      </button>
      <div class="auth-divider"><span>or</span></div>
      <form onsubmit="submitAuth(event,'${mode}')">
        ${mode === 'signup' ? `<div class="form-group"><label>Name</label><input name="uname" type="text" required autofocus placeholder="Your name" /></div>` : ''}
        <div class="form-group"><label>Email</label><input name="email" type="email" required ${mode === 'signin' ? 'autofocus' : ''} /></div>
        <div class="form-group"><label>Password</label><input name="password" type="password" required minlength="6" autocomplete="${mode === 'signin' ? 'current-password' : 'new-password'}" /></div>
        <div class="modal-footer">
          <p style="margin:0 auto 0 0;font-size:13px">
            ${mode === 'signin'
              ? `No account? <a href="#" onclick="Modal.hide();showAuthModal('signup');return false">Create one</a>
                 &nbsp;·&nbsp; <a href="#" onclick="showForgotPasswordModal();return false">Forgot password?</a>`
              : `Have an account? <a href="#" onclick="Modal.hide();showAuthModal('signin');return false">Sign in</a>`}
          </p>
          <button type="button" class="btn" onclick="Modal.hide()">Cancel</button>
          <button type="submit" class="btn btn-primary">${mode === 'signin' ? 'Sign In' : 'Create Account'}</button>
        </div>
      </form>
    </div>`);
  renderGoogleSignInButton();
}

async function submitAuth(event, mode) {
  event.preventDefault();
  const form = event.target;
  const email = form.email.value.trim();
  const password = form.password.value;
  const fs = window._fs;
  try {
    if (mode === 'signup') {
      const name = form.uname.value.trim();
      const cred = await fs.createUserWithEmailAndPassword(fs.auth, email, password);
      const invitedPlayer = State.players.find(p => p.inviteEmail === email);
      await createOrLinkUserProfile(cred.user, invitedPlayer?.id || null, name);
      Modal.hide();
      toast('Welcome to WiffleCast!', 'success');
    } else {
      await fs.signInWithEmailAndPassword(fs.auth, email, password);
      Modal.hide();
      toast('Signed in!', 'success');
    }
  } catch (err) {
    // Show error inside the modal so it's hard to miss; include raw code for debugging
    const friendly = authErrorMessage(err.code);
    const debug = err.code ? ` (${err.code})` : '';
    showAuthModal(mode, friendly + debug);
  }
}

async function signOutUser() {
  await window._fs.signOut(window._fs.auth);
  currentUser = null;
  currentUserProfile = null;
  updateAuthUI();
  Render.all();
  toast('Signed out');
}

// ── Google Identity Services (GIS) sign-in ──────────────────────────────────
// Firebase's signInWithRedirect/getRedirectResult hangs on GitHub Pages because
// the COOP header blocks the cross-origin iframe Firebase uses to retrieve the
// result. GIS + signInWithCredential bypasses this entirely: GIS uses FedCM
// (Chrome's native credential UI) so no popup or iframe is needed.

let _googleClientId = null;
async function getGoogleClientId() {
  if (_googleClientId) return _googleClientId;
  try {
    // Firebase exposes the OAuth client ID via its identitytoolkit endpoint.
    const apiKey = 'AIzaSyDp_4n3yu7pYBHGhsphp579u5qXPXFCwNE';
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: 'google.com', continueUri: location.origin + '/' }),
      }
    );
    const data = await res.json();
    if (data.authUri) {
      _googleClientId = new URL(data.authUri).searchParams.get('client_id');
    }
  } catch (e) {
    console.warn('[Google Sign-In] Could not auto-fetch client ID:', e);
  }
  return _googleClientId;
}

async function handleGoogleCredential(response) {
  const fs = window._fs;
  if (!fs || !response?.credential) return;
  try {
    const cred = fs.GoogleAuthProvider.credential(response.credential);
    const result = await fs.signInWithCredential(fs.auth, cred);
    const user = result.user;
    const invitedPlayer = State.players.find(p => p.inviteEmail === user.email);
    await createOrLinkUserProfile(user, invitedPlayer?.id || null, user.displayName);
    Modal.hide();
    toast('Signed in with Google!', 'success');
    Render.all();
  } catch (err) {
    console.error('[Google Sign-In] signInWithCredential failed:', err);
    showAuthModal('signin', 'Google sign-in failed: ' + (err.code || err.message));
  }
}

// GIS is initialized once; re-initializing causes "called multiple times" warnings.
let _gisInitialized = false;
async function ensureGISInitialized() {
  if (_gisInitialized) return true;
  const gis = typeof google !== 'undefined' && google.accounts?.id;
  if (!gis) return false;
  const clientId = await getGoogleClientId();
  if (!clientId) return false;
  gis.initialize({
    client_id: clientId,
    callback: handleGoogleCredential,
    auto_select: false,
    use_fedcm_for_prompt: true,
  });
  _gisInitialized = true;
  return true;
}

// Renders the GIS button into #google-btn-container inside the auth modal.
// Uses requestAnimationFrame so the modal is in the layout tree before we
// measure its width — fixes the button overflowing on narrow/mobile modals.
async function renderGoogleSignInButton() {
  const ready = await ensureGISInitialized();
  const container = document.getElementById('google-btn-container');
  if (!container) return;
  if (!ready) {
    container.innerHTML = `<button class="btn-google" style="width:100%;justify-content:center" onclick="signInWithGoogle()">
      <svg width="18" height="18" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"/><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58z"/></svg>
      Continue with Google
    </button>`;
    container.querySelector('button')?.addEventListener('click', signInWithGoogle);
    return;
  }
  // Wait one animation frame so the modal has been laid out and offsetWidth is real
  await new Promise(r => requestAnimationFrame(r));
  const width = Math.min(container.offsetWidth || 300, 360);
  container.innerHTML = '';
  google.accounts.id.renderButton(container, {
    theme: 'outline',
    size: 'large',
    width,
    text: 'signin_with',
    shape: 'rectangular',
    logo_alignment: 'left',
  });
}

async function signInWithGoogle() {
  renderGoogleSignInButton();
}

async function checkGoogleRedirect() {
  // Legacy: handle any session still mid-redirect from the old flow.
  // Wraps in a 4-second timeout so boot never hangs if COOP blocks the iframe.
  const fs = window._fs;
  if (!fs) return;
  try {
    const result = await Promise.race([
      fs.getRedirectResult(fs.auth),
      new Promise(resolve => setTimeout(() => resolve(null), 4000)),
    ]);
    if (!result?.user) return;
    const user = result.user;
    const invitedPlayer = State.players.find(p => p.inviteEmail === user.email);
    await createOrLinkUserProfile(user, invitedPlayer?.id || null, user.displayName);
    toast('Signed in with Google!', 'success');
  } catch (err) {
    console.warn('[Google Sign-In] checkGoogleRedirect (legacy):', err.code || err.message);
  }
}

function showForgotPasswordModal(msg = '', isSuccess = false) {
  Modal.show(`
    <div class="modal-header">
      <h3>Reset Password</h3>
      <button class="btn-icon" onclick="Modal.hide()">✕</button>
    </div>
    <form onsubmit="submitForgotPassword(event)">
      <div class="modal-body">
        ${msg ? `<div style="background:${isSuccess ? '#f0fdf4' : '#fef2f2'};border:1px solid ${isSuccess ? '#bbf7d0' : '#fecaca'};border-radius:6px;padding:8px 12px;color:${isSuccess ? '#166534' : '#b91c1c'};font-size:13px;margin-bottom:12px">${escapeHtml(msg)}</div>` : ''}
        <div class="form-group">
          <label>Email</label>
          <input name="email" type="email" required autofocus placeholder="your@email.com" />
        </div>
        <p class="help-text">We'll send a password reset link to this address.</p>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn" onclick="showAuthModal('signin')">Back</button>
        <button type="submit" class="btn btn-primary">Send Reset Email</button>
      </div>
    </form>`);
}

async function submitForgotPassword(event) {
  event.preventDefault();
  const email = event.target.email.value.trim();
  try {
    await window._fs.sendPasswordResetEmail(window._fs.auth, email);
    showForgotPasswordModal(`Reset email sent to ${email}. Check your inbox.`, true);
  } catch (err) {
    const msg = err.code === 'auth/user-not-found' ? 'No account found with that email.'
              : err.code === 'auth/invalid-email'   ? 'Invalid email address.'
              : 'Failed to send reset email. Please try again.';
    showForgotPasswordModal(msg, false);
  }
}

function showChangePasswordModal(errorMsg = '') {
  Modal.show(`
    <div class="modal-header">
      <h3>Change Password</h3>
      <button class="btn-icon" onclick="Modal.hide()">✕</button>
    </div>
    <form onsubmit="submitChangePassword(event)">
      <div class="modal-body">
        ${errorMsg ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:8px 12px;color:#b91c1c;font-size:13px;margin-bottom:12px">${escapeHtml(errorMsg)}</div>` : ''}
        <div class="form-group"><label>Current Password</label><input name="current" type="password" required autofocus autocomplete="current-password" /></div>
        <div class="form-group"><label>New Password</label><input name="newpw" type="password" required minlength="6" autocomplete="new-password" /></div>
        <div class="form-group"><label>Confirm New Password</label><input name="confirm" type="password" required minlength="6" autocomplete="new-password" /></div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn" onclick="Modal.hide()">Cancel</button>
        <button type="submit" class="btn btn-primary">Change Password</button>
      </div>
    </form>`);
}

async function submitChangePassword(event) {
  event.preventDefault();
  const form = event.target;
  const current = form.current.value;
  const newpw   = form.newpw.value;
  const confirm = form.confirm.value;
  if (newpw !== confirm) { showChangePasswordModal('New passwords do not match.'); return; }
  if (newpw.length < 6)  { showChangePasswordModal('Password must be at least 6 characters.'); return; }
  const fs = window._fs;
  try {
    const credential = fs.EmailAuthProvider.credential(currentUser.email, current);
    await fs.reauthenticateWithCredential(currentUser, credential);
    await fs.updatePassword(currentUser, newpw);
    Modal.hide();
    toast('Password changed!', 'success');
  } catch (err) {
    showChangePasswordModal(authErrorMessage(err.code));
  }
}

async function adminResetPassword(uid) {
  const u = State.users.find(u => u.uid === uid);
  if (!u?.email) { toast('No email on file for this user', 'error'); return; }
  if (!confirm(`Send a password reset email to ${u.email}?`)) return;
  try {
    const fs = window._fs;
    await fs.sendPasswordResetEmail(fs.auth, u.email);
    toast(`Reset email sent to ${u.email}`, 'success');
  } catch (err) {
    toast('Failed to send reset email: ' + (err.message || err.code), 'error');
  }
}

/* ============================================================
   STATS EVENT FILTER
   ============================================================ */

// Returns the Set of tournament IDs (+ '__none__') that have at least one game.
function getFilterKeys() {
  const keys = new Set();
  if (State.games.some(g => !g.tournamentId)) keys.add('__none__');
  State.tournaments.forEach(t => {
    if (State.games.some(g => g.tournamentId === t.id)) keys.add(t.id);
  });
  return keys;
}

// Returns a Set<gameId> matching the active filter, or null if all games should be used.
function getFilteredGameIds() {
  if (statsEventFilter === null) return null;
  const ids = new Set();
  State.games.forEach(g => {
    const key = g.tournamentId || '__none__';
    if (statsEventFilter.has(key)) ids.add(g.id);
  });
  return ids;
}

function renderStatsFilterBar() {
  const c = $('#stats-filter-bar');
  if (!c) return;
  const filterKeys = getFilterKeys();
  if (filterKeys.size <= 1) { c.innerHTML = ''; return; }

  const isFiltered = statsEventFilter !== null;
  const activeCount = isFiltered ? statsEventFilter.size : filterKeys.size;
  const totalCount  = filterKeys.size;
  const label = isFiltered ? `Events: ${activeCount} / ${totalCount}` : 'Filter by Event';
  const badge = isFiltered ? ` <span class="stats-filter-active-badge">${activeCount}</span>` : '';

  c.innerHTML = `<div class="stats-filter-bar">
    <button class="btn btn-sm stats-filter-btn${isFiltered ? ' filtered' : ''}" onclick="showStatsFilterModal()">▾ ${label}</button>
    ${isFiltered ? `<button class="btn-icon stats-filter-clear-btn" onclick="clearStatsFilter()" title="Clear filter">✕</button>` : ''}
  </div>`;
}

function showStatsFilterModal() {
  const allKeys = getFilterKeys();
  if (!allKeys.size) return;
  _statsFilterDraft = statsEventFilter === null ? null : new Set(statsEventFilter);
  Modal.show(_buildStatsFilterHtml(''));
  const inp = $('#stats-filter-search');
  if (inp) setTimeout(() => inp.focus(), 50);
}

function _buildStatsFilterHtml(searchTerm) {
  const allKeys  = getFilterKeys();
  const term     = searchTerm.toLowerCase();
  const rows     = [];

  const makeRow = (key, labelText) => {
    if (term && !labelText.toLowerCase().includes(term)) return;
    const checked = _statsFilterDraft === null || _statsFilterDraft.has(key);
    rows.push(`<label class="stats-filter-item${checked ? '' : ' unchecked'}">
      <input type="checkbox" ${checked ? 'checked' : ''} onchange="statsFilterDraftToggle('${key}')">
      <span>${escapeHtml(labelText)}</span>
    </label>`);
  };

  if (allKeys.has('__none__')) makeRow('__none__', 'No Event');
  State.tournaments.forEach(t => { if (allKeys.has(t.id)) makeRow(t.id, t.name); });

  const allChecked = _statsFilterDraft === null;
  const noneChecked = _statsFilterDraft !== null && _statsFilterDraft.size === 0;

  return `
    <div class="modal-header">
      <h2>Filter by Event</h2>
      <button class="btn-icon" onclick="Modal.hide()">✕</button>
    </div>
    <div class="modal-body">
      <input type="text" id="stats-filter-search" class="stats-filter-search-input"
        placeholder="Search events…" oninput="statsFilterSearch(this.value)"
        value="${escapeHtml(searchTerm)}" autocomplete="off">
      <div class="stats-filter-modal-actions">
        <button class="btn-link${allChecked ? ' active' : ''}" onclick="statsFilterSelectAll()">Select All</button>
        <button class="btn-link${noneChecked ? ' active' : ''}" onclick="statsFilterClearAll()">Clear All</button>
      </div>
      <div id="stats-filter-list" class="stats-filter-list">
        ${rows.length ? rows.join('') : '<div class="help-text" style="padding:8px 0">No events match.</div>'}
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="Modal.hide()">Cancel</button>
      <button class="btn btn-primary" onclick="applyStatsFilter()">Apply</button>
    </div>`;
}

function statsFilterSearch(q) {
  const term = q.toLowerCase();
  $$('#stats-filter-list .stats-filter-item').forEach(item => {
    const name = (item.querySelector('span')?.textContent || '').toLowerCase();
    item.style.display = name.includes(term) ? '' : 'none';
  });
  const empty = !$$('#stats-filter-list .stats-filter-item').some(i => i.style.display !== 'none');
  let noMatch = $('#stats-filter-no-match');
  if (empty && !noMatch) {
    const d = document.createElement('div');
    d.id = 'stats-filter-no-match';
    d.className = 'help-text';
    d.style.padding = '8px 0';
    d.textContent = 'No events match.';
    $('#stats-filter-list').appendChild(d);
  } else if (!empty && noMatch) {
    noMatch.remove();
  }
}

function statsFilterDraftToggle(key) {
  const allKeys = getFilterKeys();
  if (_statsFilterDraft === null) {
    _statsFilterDraft = new Set([...allKeys].filter(k => k !== key));
  } else {
    if (_statsFilterDraft.has(key)) {
      _statsFilterDraft.delete(key);
    } else {
      _statsFilterDraft.add(key);
      if (_statsFilterDraft.size === allKeys.size) _statsFilterDraft = null;
    }
  }
  // Update visual state of the row without re-rendering the whole modal
  const lbl = document.querySelector(`#stats-filter-list .stats-filter-item input[onchange="statsFilterDraftToggle('${key}')"]`)?.closest('label');
  if (lbl) {
    const isChecked = _statsFilterDraft === null || _statsFilterDraft.has(key);
    lbl.classList.toggle('unchecked', !isChecked);
  }
}

function statsFilterSelectAll() {
  _statsFilterDraft = null;
  $$('#stats-filter-list .stats-filter-item').forEach(item => {
    item.classList.remove('unchecked');
    const cb = item.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = true;
  });
  // Update button states
  $$('.stats-filter-modal-actions .btn-link').forEach((b, i) => b.classList.toggle('active', i === 0));
}

function statsFilterClearAll() {
  _statsFilterDraft = new Set();
  $$('#stats-filter-list .stats-filter-item').forEach(item => {
    item.classList.add('unchecked');
    const cb = item.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = false;
  });
  $$('.stats-filter-modal-actions .btn-link').forEach((b, i) => b.classList.toggle('active', i === 1));
}

function applyStatsFilter() {
  statsEventFilter = _statsFilterDraft;
  _statsFilterDraft = null;
  Modal.hide();
  Render.players();
  Render.teams();
}

function clearStatsFilter() {
  statsEventFilter = null;
  Render.players();
  Render.teams();
}

/* ============================================================
   TOURNAMENT-DETAIL STATS
   ============================================================ */

function getTournamentGameIds(tournId) {
  return new Set(State.games.filter(g => g.tournamentId === tournId).map(g => g.id));
}

// Players who appear in any event in the tournament's games (batters + pitchers)
// Also includes players in batting orders (for games that haven't started yet or have no PAs).
function getTournamentPlayers(tournId) {
  const games = State.games.filter(g => g.tournamentId === tournId);
  const pids = new Set();
  games.forEach(g => {
    (g.homeBattingOrder || []).forEach(pid => pids.add(pid));
    (g.awayBattingOrder || []).forEach(pid => pids.add(pid));
    (g.events || []).forEach(e => {
      if (e.type !== 'pa_end') return;
      if (e.batterId)  pids.add(e.batterId);
      if (e.pitcherId) pids.add(e.pitcherId);
    });
  });
  return [...pids].map(pid => State.getPlayer(pid)).filter(Boolean);
}

function renderTournPlayerStats(tournId) {
  const c = $('#tourn-player-stats');
  if (!c) return;
  const gameIds = getTournamentGameIds(tournId);
  const players = getTournamentPlayers(tournId);
  if (!players.length) { c.innerHTML = '<div class="help-text" style="padding:8px">No player data yet.</div>'; return; }

  const view = _tournStatsView;
  const cols  = view === 'pitching' ? PITCH_COLS : view === 'fielding' ? FIELD_COLS : BATTING_COLS;
  const sort  = view === 'pitching' ? _tppSort : view === 'fielding' ? _tpfSort : _tpSort;

  let rows = players.map(p => {
    const s = State.computePlayerStats(p.id, gameIds);
    const d = view === 'pitching' ? playerPitchingData(s)
            : view === 'fielding' ? playerFieldingData(s)
            : playerBattingData(s);
    return { p, d };
  });
  if (view === 'pitching') rows = rows.filter(r => (r.d.IP || 0) > 0);
  if (!rows.length) { c.innerHTML = '<div class="help-text" style="padding:8px">No stats yet for this view.</div>'; return; }

  rows.sort((a, b) => {
    if (sort.col === 'name') return b.p.name.localeCompare(a.p.name) * sort.dir;
    let av = a.d[sort.col] ?? null, bv = b.d[sort.col] ?? null;
    if (av === null) av = sort.dir > 0 ? Infinity : -Infinity;
    if (bv === null) bv = sort.dir > 0 ? Infinity : -Infinity;
    return (bv - av) * sort.dir;
  });

  const thArr = col => {
    const isSorted = sort.col === col.key;
    const arr = isSorted ? (sort.dir === -1 ? '▼' : '▲') : '<span style="opacity:0.25">▼</span>';
    return `<th class="num-col ${isSorted ? 'sorted' : ''}" onclick="sortTournPlayerStats('${tournId}','${col.key}','${view}')">${col.label}<span class="sort-arr">${arr}</span></th>`;
  };
  const nameSortArr = sort.col === 'name'
    ? (sort.dir === -1 ? '<span class="sort-arr">▼</span>' : '<span class="sort-arr">▲</span>')
    : '<span class="sort-arr" style="opacity:0.25">▼</span>';

  const myPid = currentUserProfile?.playerId;
  const tbody = rows.map(({ p, d }) => {
    const cells = cols.map(col => `<td>${col.fmt ? col.fmt(d[col.key]) : (d[col.key] ?? '—')}</td>`).join('');
    return `<tr class="${myPid === p.id ? 'mine' : ''}" style="cursor:pointer" onclick="showPlayerStatsModal('${p.id}')">
      <td>${escapeHtml(p.name)}</td>${cells}
    </tr>`;
  }).join('');

  c.innerHTML = `<div class="stats-table-wrap"><table class="stats-table">
    <thead><tr>
      <th onclick="sortTournPlayerStats('${tournId}','name','${view}')">Player${nameSortArr}</th>
      ${cols.map(thArr).join('')}
    </tr></thead>
    <tbody>${tbody}</tbody>
  </table></div>`;
}

function renderTournTeamStats(tournId) {
  const c = $('#tourn-team-stats');
  if (!c) return;
  const t = State.getTournament(tournId);
  if (!t) return;
  const gameIds = getTournamentGameIds(tournId);
  if (!gameIds.size) { c.innerHTML = '<div class="help-text" style="padding:8px">No games played yet.</div>'; return; }

  const teams = (t.teamIds || []).map(tid => State.getTeam(tid)).filter(Boolean);
  if (!teams.length) { c.innerHTML = '<div class="help-text" style="padding:8px">No teams.</div>'; return; }

  const view = _tournTeamView;
  const COLS = view === 'pitching' ? PITCH_COLS : BATTING_COLS;
  const sort = view === 'pitching' ? _ttpSort : _ttbSort;

  let rows = teams.map(team => {
    const bat = State.computeTeamBattingStats(team.id, gameIds);
    const pit = State.computeTeamPitchingStats(team.id, gameIds);
    const ts  = State.computeTeamStats(team.id, gameIds);
    const d   = view === 'pitching' ? teamPitchingData(pit, ts.gamesPlayed) : teamBattingData(bat, ts.gamesPlayed);
    return { team, d };
  });

  rows.sort((a, b) => {
    if (sort.col === 'name') return b.team.name.localeCompare(a.team.name) * sort.dir;
    let av = a.d[sort.col] ?? null, bv = b.d[sort.col] ?? null;
    if (av === null) av = sort.dir > 0 ? Infinity : -Infinity;
    if (bv === null) bv = sort.dir > 0 ? Infinity : -Infinity;
    return (bv - av) * sort.dir;
  });

  const thArr = col => {
    const isSorted = sort.col === col.key;
    const arr = isSorted ? (sort.dir === -1 ? '▼' : '▲') : '<span style="opacity:0.25">▼</span>';
    return `<th class="num-col ${isSorted ? 'sorted' : ''}" onclick="sortTournTeamStats('${tournId}','${col.key}','${view}')">${col.label}<span class="sort-arr">${arr}</span></th>`;
  };
  const nameSortArr = sort.col === 'name'
    ? (sort.dir === -1 ? '<span class="sort-arr">▼</span>' : '<span class="sort-arr">▲</span>')
    : '<span class="sort-arr" style="opacity:0.25">▼</span>';

  const tbody = rows.map(({ team, d }) =>
    `<tr style="cursor:pointer" onclick="showTeamStatsModal('${team.id}')">
      <td>${escapeHtml(team.name)}</td>
      ${COLS.map(col => `<td>${col.fmt ? col.fmt(d[col.key]) : (d[col.key] ?? '—')}</td>`).join('')}
    </tr>`
  ).join('');

  c.innerHTML = `<div class="stats-table-wrap"><table class="stats-table">
    <thead><tr>
      <th onclick="sortTournTeamStats('${tournId}','name','${view}')">Team${nameSortArr}</th>
      ${COLS.map(thArr).join('')}
    </tr></thead>
    <tbody>${tbody}</tbody>
  </table></div>`;
}

function setTournStatsView(tournId, view) {
  _tournStatsView = view;
  $$('#tourn-player-subnav button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  renderTournPlayerStats(tournId);
}

function setTournTeamView(tournId, view) {
  _tournTeamView = view;
  $$('#tourn-team-subnav button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  renderTournTeamStats(tournId);
}

function sortTournPlayerStats(tournId, col, view) {
  const sort = view === 'pitching' ? _tppSort : view === 'fielding' ? _tpfSort : _tpSort;
  if (sort.col === col) sort.dir *= -1;
  else { sort.col = col; sort.dir = (col === 'ERA' || col === 'WHIP' || col === 'BB') ? 1 : -1; }
  renderTournPlayerStats(tournId);
}

function sortTournTeamStats(tournId, col, view) {
  const sort = view === 'pitching' ? _ttpSort : _ttbSort;
  if (sort.col === col) sort.dir *= -1;
  else { sort.col = col; sort.dir = (col === 'ERA' || col === 'WHIP') ? 1 : -1; }
  renderTournTeamStats(tournId);
}

async function invitePlayer(playerId) {
  const player = State.getPlayer(playerId);
  if (!player) return;
  const email = window.prompt(`Enter email address for ${player.name}:\n(They'll receive an invite email with a link to sign up.)`);
  if (!email || !email.includes('@')) { if (email !== null) toast('Invalid email', 'error'); return; }

  const cfg = getEmailConfig();
  if (!cfg) { showEmailSetupModal(); return; }

  const appUrl = window.location.origin + window.location.pathname;
  try {
    emailjs.init(cfg.publicKey);
    await emailjs.send(cfg.serviceId, cfg.templateId, {
      to_email: email,
      to_name: player.name,
      subject: `You're invited to WiffleCast!`,
      message: `Hi ${player.name},\n\nYou've been invited to join WiffleCast!\n\nClick here to sign up:\n${appUrl}\n\nUse this email address (${email}) when creating your account and you'll automatically be linked to your player profile.\n\nSee you on the field!`,
    });
  } catch (err) {
    toast('Failed to send invite email: ' + err.message, 'error');
    return;
  }

  player.inviteEmail = email;
  player.invitePending = true;
  await Storage.savePlayer(player);
  Render.players();
  toast(`Invite sent to ${email}`, 'success');
}

async function cancelInvite(playerId) {
  const player = State.getPlayer(playerId);
  if (!player) return;
  if (!confirm(`Cancel invite for ${player.name}?`)) return;
  player.inviteEmail = null;
  player.invitePending = false;
  await Storage.savePlayer(player);
  Render.players();
  Render.adminPlayers();
  toast(`Invite cancelled for ${player.name}`, 'success');
}

async function handleEmailLinkSignIn() {
  const fs = window._fs;
  const params = new URLSearchParams(window.location.search);
  const playerId = params.get('invitePlayerId') || localStorage.getItem('wc_invite_pid');
  let email = localStorage.getItem('wc_invite_email');
  if (!email) email = window.prompt('Please confirm your email address to complete sign-in:');
  if (!email) return;
  try {
    const result = await fs.signInWithEmailLink(fs.auth, email, window.location.href);
    localStorage.removeItem('wc_invite_email');
    localStorage.removeItem('wc_invite_pid');
    history.replaceState({}, '', window.location.pathname);
    const name = window.prompt('Welcome! Enter your display name:') || email.split('@')[0];
    await createOrLinkUserProfile(result.user, playerId, name);
    toast('Welcome to WiffleCast, ' + (currentUserProfile?.name || '') + '!', 'success');
  } catch (err) {
    toast('Sign-in link issue: ' + err.message, 'error');
  }
}

function showLinkPlayerModal(uid) {
  if (!isAdminUser()) return;
  const user = State.getUser(uid); if (!user) return;
  const currentPlayer = user.playerId ? State.getPlayer(user.playerId) : null;
  const sorted = [...State.players].sort((a, b) => a.name.localeCompare(b.name));
  const opts = sorted.map(p => {
    const taken = p.userId && p.userId !== uid ? ' (linked to another user)' : '';
    return `<option value="${p.id}" ${p.id === user.playerId ? 'selected' : ''}>${escapeHtml(p.name)}${taken ? escapeHtml(taken) : ''}</option>`;
  }).join('');
  Modal.show(`
    <div class="modal-header">
      <h3>Link Player — ${escapeHtml(user.name || user.email || uid)}</h3>
      <button class="btn-icon" onclick="Modal.hide()">✕</button>
    </div>
    <div class="modal-body">
      <p class="help-text" style="margin-bottom:12px">Select the player profile to link to this account. This lets the user edit their player and see their personal stats on the Home tab.</p>
      <label class="form-label">Player</label>
      <select id="link-player-select" class="form-input">
        <option value="">— none —</option>
        ${opts}
      </select>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="Modal.hide()">Cancel</button>
      <button class="btn btn-primary" onclick="submitLinkPlayer('${uid}')">Save</button>
    </div>`);
}

async function submitLinkPlayer(uid) {
  if (!isAdminUser()) return;
  const user = State.getUser(uid); if (!user) return;
  const newPlayerId = document.getElementById('link-player-select')?.value || null;
  const oldPlayerId = user.playerId || null;
  if (newPlayerId === oldPlayerId) { Modal.hide(); return; }

  // Clear old player's userId if it was set to this user
  if (oldPlayerId) {
    const oldP = State.getPlayer(oldPlayerId);
    if (oldP && oldP.userId === uid) {
      oldP.userId = null;
      oldP.invitePending = false;
      await Storage.savePlayer(oldP);
    }
  }

  // Link new player
  if (newPlayerId) {
    const newP = State.getPlayer(newPlayerId);
    if (newP) {
      newP.userId = uid;
      newP.invitePending = false;
      await Storage.savePlayer(newP);
    }
  }

  const updated = { ...user, playerId: newPlayerId || null };
  await Storage.saveUser(updated);
  Modal.hide();
  toast('Player link updated', 'success');
}

async function toggleCanScore(uid) {
  const user = State.getUser(uid);
  if (!user) return;
  const updated = { ...user, canScore: !user.canScore };
  await Storage.saveUser(updated);
  toast(`${updated.name || uid}: scoring ${updated.canScore ? 'enabled' : 'disabled'}`, 'success');
}

const Render = {
  all() { this.home(); this.players(); this.teams(); this.games(); this.users(); this.adminPlayers(); this.adminTeams(); this.adminGames(); this.adminEvents(); this.tournaments(); },

  tournaments() {
    const btnAdd = $('#btn-add-tournament');
    if (btnAdd) btnAdd.style.display = isAdmin() ? '' : 'none';
    const listEl = $('#tournaments-list'); if (!listEl) return;
    const sorted = [...State.tournaments].sort((a, b) => b.createdAt - a.createdAt);
    if (!sorted.length) {
      listEl.innerHTML = '<div class="empty-state" style="padding:24px"><p>No events found.</p></div>';
      return;
    }
    listEl.innerHTML = sorted.map(t => {
      const games = State.games.filter(g => g.tournamentId === t.id);
      const done  = games.filter(g => g.status === 'completed').length;
      return `<div class="player-list-item${selectedTournamentId === t.id ? ' selected' : ''}" onclick="selectTournament('${t.id}')">
        <div class="pli-name">${escapeHtml(t.name)}</div>
        <div class="pli-sub">${t.teamIds.length} teams · ${done}/${games.length} games played</div>
      </div>`;
    }).join('');
    const split = $('#tournaments-split');
    if (selectedTournamentId) {
      renderTournamentDetail(selectedTournamentId);
    } else if (split) {
      split.classList.remove('tourn-has-detail');
    }
  },

  home() {
    const c = $('#home-container'); if (!c) return;
    const myPid = currentUserProfile?.playerId;
    const myPlayer = myPid ? State.getPlayer(myPid) : null;

    // My player card
    let playerCard = '';
    if (myPlayer) {
      const s = State.computePlayerStats(myPid);
      playerCard = `
        <div class="home-card">
          <div class="home-section-title">My Player</div>
          <div class="home-player-name" style="display:flex;align-items:center;gap:8px">
            <span>${escapeHtml(myPlayer.jerseyNumber ? '#' + myPlayer.jerseyNumber + ' ' + myPlayer.name : myPlayer.name)}</span>
            <button class="btn-icon" title="Edit name/number" onclick="showPlayerModal('${myPid}')" style="font-size:13px;padding:2px 5px">✎</button>
          </div>
          ${renderPlayerStatTable(s)}
        </div>`;
    } else if (currentUser) {
      playerCard = `
        <div class="home-card">
          <div class="home-section-title">My Player</div>
          <p style="color:#6b7280;margin:0 0 12px 0;font-size:14px">You haven't linked to a player yet.</p>
          <button class="btn btn-primary btn-sm" onclick="showCreateMyPlayerModal()">+ Create My Player</button>
        </div>`;
    } else {
      playerCard = `
        <div class="home-card">
          <div class="home-section-title">Welcome to WiffleCast</div>
          <p style="color:#6b7280;margin:0 0 12px 0;font-size:14px">Sign in to track your stats, manage your team, and score games.</p>
          <button class="btn btn-primary btn-sm" onclick="showAuthModal('signin')">Sign In</button>
        </div>`;
    }

    // Not signed in — show welcome card only
    if (!currentUser) {
      c.innerHTML = `<div style="padding-top:8px"><div class="home-grid">${playerCard}</div></div>`;
      return;
    }

    // My teams
    const myTeams = myPlayer
      ? State.teams.filter(t => t.playerIds && t.playerIds.includes(myPid))
      : [];
    const tv = homeTeamsView;
    const tTabBtn = (v, label) =>
      `<button class="${tv===v?'active':''}" onclick="setHomeTeamsView('${v}')">${label}</button>`;
    const teamsCard = `
      <div class="home-card">
        <div class="home-section-title">My Teams</div>
        <div class="players-subnav" style="margin-bottom:8px">
          ${tTabBtn('record','Record')}${tTabBtn('batting','Batting')}${tTabBtn('pitching','Pitching')}${tTabBtn('fielding','Fielding')}
        </div>
        ${renderHomeTeamsSection(myTeams, tv)}
      </div>`;

    // Recent games — filtered to current player's games when linked
    const recent = [...State.games]
      .filter(g => {
        if (g.status !== 'completed' && g.status !== 'in_progress') return false;
        if (!myPid) return true; // signed in but not linked, show all
        return (g.homeBattingOrder || []).includes(myPid) ||
               (g.awayBattingOrder || []).includes(myPid);
      })
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 6);
    const recentHtml = recent.map(g => {
      const home = State.getTeam(g.homeTeamId), away = State.getTeam(g.awayTeamId);
      const isLive = g.status === 'in_progress';
      const score = g.status === 'completed' ? `${g.score.away}-${g.score.home}` : 'LIVE';
      const date = new Date(g.createdAt).toLocaleDateString();
      const actions = `<div style="display:flex;gap:6px;align-items:center" onclick="event.stopPropagation()">
        <div class="home-game-score ${isLive ? 'status-in_progress' : ''}">${score}</div>
        <button class="btn btn-sm" onclick="renderLiveGame('${g.id}',true)">👁 Watch</button>
        ${isLive && canUserScore() ? `<button class="btn btn-sm btn-primary" onclick="openGameForScoring('${g.id}')">▶ Resume</button>` : ''}
      </div>`;
      return `<div class="home-recent-game" onclick="selectGame('${g.id}');switchTab('games')">
        <div>
          <div style="font-weight:600">${escapeHtml(away?.name||'?')} @ ${escapeHtml(home?.name||'?')}</div>
          <div style="font-size:12px;color:#9ca3af">${date}</div>
        </div>
        ${actions}
      </div>`;
    }).join('') || '<p style="color:#6b7280;font-size:14px;margin:0">No games yet.</p>';

    c.innerHTML = `
      <div style="padding-top:8px">
        <div class="home-grid">
          ${playerCard}
          ${teamsCard}
          <div class="home-card home-card-full">
            <div class="home-section-title">${myPid ? 'My Recent Games' : 'Recent Games'}</div>
            ${recentHtml}
          </div>
        </div>
      </div>`;
  },

  users() {
    const c = $('#users-container'); if (!c) return;
    if (!isAdminUser()) { c.innerHTML = ''; return; }
    const tog = $('#admin-features-toggle');
    if (tog) tog.innerHTML = `
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
        <span style="font-size:12px;color:#111827">Show admin controls site-wide</span>
        <input type="checkbox" ${adminFeaturesEnabled ? 'checked' : ''} onchange="toggleAdminFeatures()" style="width:16px;height:16px;cursor:pointer" />
      </label>`;
    if (!State.users.length) {
      c.innerHTML = '<div class="empty-state"><h3>No registered users yet</h3><p>Users appear here after they create an account.</p></div>';
      return;
    }
    const rows = State.users.map(u => {
      const player = u.playerId ? State.getPlayer(u.playerId) : null;
      return `<tr>
        <td>${escapeHtml(u.name || '—')}</td>
        <td><span class="muted small">${escapeHtml(u.email || u.uid)}</span></td>
        <td>
          <span style="margin-right:6px">${player ? escapeHtml(player.name) : '<span class="muted">—</span>'}</span>
          <button class="btn-icon" title="${player ? 'Change linked player' : 'Link a player'}" onclick="showLinkPlayerModal('${u.uid}')">✎</button>
        </td>
        <td>
          ${u.email === ADMIN_EMAIL
            ? '<span style="font-size:13px;color:#6b7280">Admin</span>'
            : `<label style="display:flex;align-items:center;justify-content:flex-end;gap:6px;cursor:pointer">
                <span style="font-size:13px">${u.canScore ? 'Allowed' : 'Not allowed'}</span>
                <input type="checkbox" ${u.canScore ? 'checked' : ''} onchange="toggleCanScore('${u.uid}')" />
              </label>`}
        </td>
        <td style="white-space:nowrap">
          ${u.email && u.email !== ADMIN_EMAIL
            ? `<button class="btn-icon" title="Send password reset email" onclick="adminResetPassword('${u.uid}')">🔑</button>`
            : ''}
          <button class="btn-icon" title="Delete user" onclick="deleteUser('${u.uid}')">🗑</button>
        </td>
      </tr>`;
    }).join('');
    c.innerHTML = `<div class="stats-table-wrap"><table class="stats-table">
      <thead><tr><th>Name</th><th>Email/ID</th><th>Player</th><th>Can Score</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  },

  adminPlayers() {
    const c = $('#admin-players-container'); if (!c) return;
    if (!isAdminUser()) { c.innerHTML = ''; return; }
    if (!State.players.length) {
      c.innerHTML = '<div class="empty-state"><p>No players yet.</p></div>';
      return;
    }
    const sorted = [...State.players].sort((a, b) => a.name.localeCompare(b.name));
    const rows = sorted.map(p => {
      const status = p.userId
        ? '<span class="badge badge-linked">Linked</span>'
        : p.invitePending
          ? `<span class="badge badge-invited">Invited</span> <span class="muted small">${escapeHtml(p.inviteEmail || '')}</span>`
          : '<span class="badge badge-guest">Guest</span>';
      const inviteBtn = !p.userId
        ? p.invitePending
          ? `<button class="btn-icon" title="Cancel invite" onclick="cancelInvite('${p.id}')">✕</button>`
          : `<button class="btn-icon" title="Invite" onclick="invitePlayer('${p.id}')">✉</button>`
        : '';
      return `<tr>
        <td>${escapeHtml(p.name)}</td>
        <td>${status}</td>
        <td style="white-space:nowrap">
          <button class="btn-icon" title="Edit" onclick="showPlayerModal('${p.id}')">✎</button>
          ${inviteBtn}
          <button class="btn-icon" title="Delete" onclick="deletePlayer('${p.id}')">🗑</button>
        </td>
      </tr>`;
    }).join('');
    c.innerHTML = `<div class="stats-table-wrap"><table class="stats-table">
      <thead><tr><th>Name</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  },

  adminTeams() {
    const c = $('#admin-teams-container'); if (!c) return;
    if (!isAdminUser()) { c.innerHTML = ''; return; }
    if (!State.teams.length) {
      c.innerHTML = '<div class="empty-state"><p>No teams yet.</p></div>';
      return;
    }
    const sorted = [...State.teams].sort((a, b) => a.name.localeCompare(b.name));
    const rows = sorted.map(t => {
      const playerCount = (t.playerIds || []).length;
      return `<tr>
        <td>${escapeHtml(t.name)}</td>
        <td><span class="muted small">${playerCount} player${playerCount !== 1 ? 's' : ''}</span></td>
        <td style="white-space:nowrap">
          <button class="btn-icon" title="Edit" onclick="showTeamModal('${t.id}', true)">✎</button>
          ${isAdminUser() ? `<button class="btn-icon" title="Delete" onclick="deleteTeam('${t.id}')">🗑</button>` : ''}
        </td>
      </tr>`;
    }).join('');
    c.innerHTML = `<div class="stats-table-wrap"><table class="stats-table">
      <thead><tr><th>Name</th><th>Players</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  },

  adminGames() {
    const c = $('#admin-games-container'); if (!c) return;
    if (!isAdminUser()) { c.innerHTML = ''; return; }
    if (!State.games.length) {
      c.innerHTML = '<div class="empty-state"><p>No games yet.</p></div>';
      return;
    }
    const sorted = [...State.games].sort((a, b) => b.createdAt - a.createdAt);
    const rows = sorted.map(g => {
      const home = State.getTeam(g.homeTeamId), away = State.getTeam(g.awayTeamId);
      const date = new Date(g.createdAt).toLocaleDateString();
      const statusLabel = g.status === 'completed' ? `Final ${g.score.away}–${g.score.home}`
        : g.status === 'in_progress' ? 'In Progress'
        : 'Not Started';
      const eventName = g.tournamentId ? (State.getTournament(g.tournamentId)?.name || g.tournamentName || null) : null;
      return `<tr>
        <td>${escapeHtml(away?.name||'?')} @ ${escapeHtml(home?.name||'?')}<div class="muted small" style="margin-top:2px">${date}${eventName ? ` · 📋 ${escapeHtml(eventName)}` : ''}</div></td>
        <td style="white-space:nowrap"><span class="game-card-status status-${g.status}" style="font-size:11px">${statusLabel}</span></td>
        <td style="white-space:nowrap">
          <button class="btn-icon" title="Open" onclick="selectGame('${g.id}');switchTab('games')">↗</button>
          <button class="btn-icon" title="Delete" onclick="deleteGame('${g.id}');Render.adminGames()">🗑</button>
        </td>
      </tr>`;
    }).join('');
    c.innerHTML = `<div class="stats-table-wrap"><table class="stats-table">
      <thead><tr><th>Matchup</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  },

  adminEvents() {
    const c = $('#admin-events-container'); if (!c) return;
    if (!isAdminUser()) { c.innerHTML = ''; return; }
    if (!State.tournaments.length) {
      c.innerHTML = '<div class="empty-state"><p>No events yet.</p></div>';
      return;
    }
    const sorted = [...State.tournaments].sort((a, b) => b.createdAt - a.createdAt);
    const rows = sorted.map(t => {
      const gameCount = State.games.filter(g => g.tournamentId === t.id).length;
      return `<tr>
        <td>${escapeHtml(t.name)}</td>
        <td class="muted small" style="text-align:center">${gameCount}</td>
        <td style="white-space:nowrap">
          <button class="btn-icon" title="Edit" onclick="showTournamentModal('${t.id}')">✎</button>
          <button class="btn-icon" title="Open" onclick="selectTournament('${t.id}');switchTab('tournaments')">↗</button>
          <button class="btn-icon" title="Delete" onclick="deleteTournamentUI('${t.id}')">🗑</button>
        </td>
      </tr>`;
    }).join('');
    c.innerHTML = `<div class="stats-table-wrap"><table class="stats-table">
      <thead><tr><th>Name</th><th style="text-align:center">Games</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  },

  players() {
    renderStatsFilterBar();
    const c = $('#players-container');

    // Toolbar buttons (next to Players section heading)
    const toolbar = $('#players-toolbar');
    if (toolbar) {
      let btns = '';
      if (isAdmin()) {
        btns = '<button class="btn btn-primary btn-sm" onclick="showPlayerModal()">+ Add Player</button>';
      } else if (currentUser && !currentUserProfile?.playerId) {
        btns = '<button class="btn btn-primary btn-sm" onclick="showCreateMyPlayerModal()">+ Create My Player</button>';
      }
      toolbar.innerHTML = btns;
    }

    const sorted = [...State.players].sort((a, b) => a.name.localeCompare(b.name));

    if (!sorted.length) {
      c.innerHTML = `<div class="empty-state">
        <h3>No players yet</h3>
        <p>Add players to start tracking stats and building teams.</p>
      </div>`;
      return;
    }

    // ── STATS GRID VIEW (batting | pitching | fielding) ────────────
    const which = playersView;
    const sort  = which === 'pitching' ? pitchSort : which === 'fielding' ? fieldSort : statsSort;
    const cols  = which === 'pitching' ? PITCH_COLS : which === 'fielding' ? FIELD_COLS : BATTING_COLS;

    // Build rows with normalized data objects (unified keys shared with team cols)
    const _gameIds = getFilteredGameIds();
    let rows = sorted.map(p => {
      const s = State.computePlayerStats(p.id, _gameIds);
      const d = which === 'pitching' ? playerPitchingData(s)
              : which === 'fielding' ? playerFieldingData(s)
              : playerBattingData(s);
      return { p, d };
    });

    // Sort
    rows.sort((a, b) => {
      if (sort.col === 'name') return b.p.name.localeCompare(a.p.name) * sort.dir;
      let av = a.d[sort.col] ?? null;
      let bv = b.d[sort.col] ?? null;
      if (av === null) av = sort.dir > 0 ? Infinity : -Infinity;
      if (bv === null) bv = sort.dir > 0 ? Infinity : -Infinity;
      return (bv - av) * sort.dir;
    });

    const thArr = col => {
      const isSorted = sort.col === col.key;
      const arr = isSorted ? (sort.dir === -1 ? '▼' : '▲') : '<span style="opacity:0.25">▼</span>';
      return `<th class="num-col ${isSorted ? 'sorted' : ''}" onclick="sortStats('${col.key}','${which}')">${col.label}<span class="sort-arr">${arr}</span></th>`;
    };
    const nameSortArr = sort.col === 'name'
      ? (sort.dir === -1 ? '<span class="sort-arr">▼</span>' : '<span class="sort-arr">▲</span>')
      : '<span class="sort-arr" style="opacity:0.25">▼</span>';

    const headers = `<tr>
      <th onclick="sortStats('name','${which}')">Player${nameSortArr}</th>
      ${cols.map(thArr).join('')}
    </tr>`;

    const myPid = currentUserProfile?.playerId;
    const tBody = rows.map(({ p, d }) => {
      const cells = cols.map(col => {
        const disp = col.fmt ? col.fmt(d[col.key]) : (d[col.key] ?? '—');
        return `<td>${disp}</td>`;
      }).join('');
      const mine = myPid && p.id === myPid ? ' mine' : '';
      return `<tr onclick="showPlayerStatsModal('${p.id}')" style="cursor:pointer" class="${mine.trim()}" title="View ${escapeHtml(p.name)}'s stats">
        <td>${escapeHtml(p.name)}</td>
        ${cells}
      </tr>`;
    }).join('');

    c.innerHTML = `<div class="stats-table-wrap">
      <table class="stats-table">
        <thead>${headers}</thead>
        <tbody>${tBody}</tbody>
      </table>
    </div>`;
  },

  teams() {
    const c = $('#teams-container');
    if (!c) return;
    const toolbar = $('#teams-toolbar');
    if (toolbar) {
      const myPid = currentUserProfile?.playerId;
      const selectedTeam = selectedTeamId ? State.getTeam(selectedTeamId) : null;
      const canEditSelected = selectedTeam && (isAdmin() || (myPid && (selectedTeam.playerIds || []).includes(myPid)));
      const editBtn = canEditSelected ? `<button class="btn btn-sm" onclick="showTeamModal('${selectedTeamId}')">✎ Edit Team</button>` : '';
      const addBtn  = isAdmin() ? '<button class="btn btn-primary btn-sm" onclick="showTeamModal()">+ Add Team</button>' : '';
      toolbar.innerHTML = [editBtn, addBtn].filter(Boolean).join(' ');
    }

    if (!State.teams.length) {
      const hasPlayers = State.players.length >= 2;
      c.innerHTML = `<div class="empty-state">
        <h3>No teams yet</h3>
        <p>${hasPlayers ? 'Group your players into teams.' : 'Add at least 2 players first, then create a team.'}</p>
        ${hasPlayers && isAdmin() ? '<button class="btn btn-primary" onclick="showTeamModal()">+ Add Team</button>' : ''}
      </div>`;
      return;
    }

    const sorted = [...State.teams].sort((a, b) => a.name.localeCompare(b.name));
    const myPid = currentUserProfile?.playerId;
    const isMyTeam = (t) => !!(myPid && (t.playerIds || []).includes(myPid));
    const teamNameCell = (t) => {
      return `<td><span style="cursor:pointer;border-bottom:1px dashed #9ca3af" onclick="event.stopPropagation();showTeamStatsModal('${t.id}')">${escapeHtml(t.name)}</span></td>`;
    };
    const teamRowClass = (t) => isMyTeam(t) ? 'mine' : '';
    const _gameIds = getFilteredGameIds();

    // ── BATTING GRID ──
    if (teamsView === 'batting') {
      const COLS = BATTING_COLS;
      const sort = teamBatSort;
      let rows = sorted.map(t => ({ t, d: teamBattingData(State.computeTeamBattingStats(t.id, _gameIds), State.computeTeamStats(t.id, _gameIds).gamesPlayed) }));
      rows.sort((a, b) => {
        if (sort.col === 'name') return b.t.name.localeCompare(a.t.name) * sort.dir;
        let av = a.d[sort.col] ?? 0, bv = b.d[sort.col] ?? 0;
        return (bv - av) * sort.dir;
      });
      const thArr = col => {
        const isSorted = sort.col === col.key;
        const arr = isSorted ? (sort.dir === -1 ? '▼' : '▲') : '<span style="opacity:0.25">▼</span>';
        return `<th class="num-col ${isSorted ? 'sorted' : ''}" onclick="sortTeamStats('${col.key}','batting')">${col.label}<span class="sort-arr">${arr}</span></th>`;
      };
      const nameSortArr = sort.col === 'name' ? (sort.dir === -1 ? '<span class="sort-arr">▼</span>' : '<span class="sort-arr">▲</span>') : '<span class="sort-arr" style="opacity:0.25">▼</span>';
      c.innerHTML = `<div class="stats-table-wrap"><table class="stats-table">
        <thead><tr><th onclick="sortTeamStats('name','batting')">Team${nameSortArr}</th>${COLS.map(thArr).join('')}</tr></thead>
        <tbody>${rows.map(({ t, d }) => `<tr onclick="selectTeam('${t.id}');setTeamsView('batting')" style="cursor:pointer" class="${teamRowClass(t)}">
          ${teamNameCell(t)}
          ${COLS.map(col => `<td>${col.fmt ? col.fmt(d[col.key]) : (d[col.key] ?? '—')}</td>`).join('')}
        </tr>`).join('')}</tbody>
      </table></div>`;
      return;
    }

    // ── PITCHING GRID ──
    if (teamsView === 'pitching') {
      const COLS = PITCH_COLS;
      const sort = teamPitSort;
      let rows = sorted.map(t => ({ t, d: teamPitchingData(State.computeTeamPitchingStats(t.id, _gameIds), State.computeTeamStats(t.id, _gameIds).gamesPlayed) }));
      rows.sort((a, b) => {
        if (sort.col === 'name') return b.t.name.localeCompare(a.t.name) * sort.dir;
        let av = a.d[sort.col] ?? null, bv = b.d[sort.col] ?? null;
        if (av === null) av = sort.dir > 0 ? Infinity : -Infinity;
        if (bv === null) bv = sort.dir > 0 ? Infinity : -Infinity;
        return (bv - av) * sort.dir;
      });
      const thArr = col => {
        const isSorted = sort.col === col.key;
        const arr = isSorted ? (sort.dir === -1 ? '▼' : '▲') : '<span style="opacity:0.25">▼</span>';
        return `<th class="num-col ${isSorted ? 'sorted' : ''}" onclick="sortTeamStats('${col.key}','pitching')">${col.label}<span class="sort-arr">${arr}</span></th>`;
      };
      const nameSortArr = sort.col === 'name' ? (sort.dir === -1 ? '<span class="sort-arr">▼</span>' : '<span class="sort-arr">▲</span>') : '<span class="sort-arr" style="opacity:0.25">▼</span>';
      c.innerHTML = `<div class="stats-table-wrap"><table class="stats-table">
        <thead><tr><th onclick="sortTeamStats('name','pitching')">Team${nameSortArr}</th>${COLS.map(thArr).join('')}</tr></thead>
        <tbody>${rows.map(({ t, d }) => `<tr onclick="selectTeam('${t.id}');setTeamsView('batting')" style="cursor:pointer" class="${teamRowClass(t)}">
          ${teamNameCell(t)}
          ${COLS.map(col => `<td>${col.fmt ? col.fmt(d[col.key]) : (d[col.key] ?? '—')}</td>`).join('')}
        </tr>`).join('')}</tbody>
      </table></div>`;
      return;
    }

    // ── FIELDING GRID ──
    if (teamsView === 'fielding') {
      const COLS = FIELD_COLS;
      const sort = teamFieldSort;
      let rows = sorted.map(t => ({ t, d: State.computeTeamFieldingStats(t.id, _gameIds) }));
      rows.sort((a, b) => {
        if (sort.col === 'name') return b.t.name.localeCompare(a.t.name) * sort.dir;
        return ((b.d[sort.col] ?? 0) - (a.d[sort.col] ?? 0)) * sort.dir;
      });
      const thArr = col => {
        const isSorted = sort.col === col.key;
        const arr = isSorted ? (sort.dir === -1 ? '▼' : '▲') : '<span style="opacity:0.25">▼</span>';
        return `<th class="num-col ${isSorted ? 'sorted' : ''}" onclick="sortTeamStats('${col.key}','fielding')">${col.label}<span class="sort-arr">${arr}</span></th>`;
      };
      const nameSortArr = sort.col === 'name' ? (sort.dir === -1 ? '<span class="sort-arr">▼</span>' : '<span class="sort-arr">▲</span>') : '<span class="sort-arr" style="opacity:0.25">▼</span>';
      c.innerHTML = `<div class="stats-table-wrap"><table class="stats-table">
        <thead><tr><th onclick="sortTeamStats('name','fielding')">Team${nameSortArr}</th>${COLS.map(thArr).join('')}</tr></thead>
        <tbody>${rows.map(({ t, d }) => `<tr onclick="selectTeam('${t.id}');setTeamsView('batting')" style="cursor:pointer" class="${teamRowClass(t)}">
          ${teamNameCell(t)}
          ${COLS.map(col => `<td>${col.fmt ? col.fmt(d[col.key]) : (d[col.key] ?? '—')}</td>`).join('')}
        </tr>`).join('')}</tbody>
      </table></div>`;
      return;
    }

    // ── RECORD GRID ──
    if (teamsView === 'record') {
      const COLS = TEAM_RECORD_COLS;
      const sort = teamRecordSort;
      let rows = sorted.map(t => {
        const ts = State.computeTeamStats(t.id, _gameIds);
        return { t, d: { GP: ts.gamesPlayed, W: ts.wins, L: ts.losses, RF: ts.runsFor, RA: ts.runsAgainst } };
      });
      rows.sort((a, b) => {
        if (sort.col === 'name') return b.t.name.localeCompare(a.t.name) * sort.dir;
        return ((b.d[sort.col] ?? 0) - (a.d[sort.col] ?? 0)) * sort.dir;
      });
      const thArr = col => {
        const isSorted = sort.col === col.key;
        const arr = isSorted ? (sort.dir === -1 ? '▼' : '▲') : '<span style="opacity:0.25">▼</span>';
        return `<th class="num-col ${isSorted ? 'sorted' : ''}" onclick="sortTeamStats('${col.key}','record')">${col.label}<span class="sort-arr">${arr}</span></th>`;
      };
      const nameSortArr = sort.col === 'name' ? (sort.dir === -1 ? '<span class="sort-arr">▼</span>' : '<span class="sort-arr">▲</span>') : '<span class="sort-arr" style="opacity:0.25">▼</span>';
      c.innerHTML = `<div class="stats-table-wrap"><table class="stats-table">
        <thead><tr><th onclick="sortTeamStats('name','record')">Team${nameSortArr}</th>${COLS.map(thArr).join('')}</tr></thead>
        <tbody>${rows.map(({ t, d }) => `<tr onclick="selectTeam('${t.id}');setTeamsView('record')" style="cursor:pointer" class="${teamRowClass(t)}">
          ${teamNameCell(t)}
          ${COLS.map(col => `<td>${col.fmt ? col.fmt(d[col.key]) : (d[col.key] ?? '—')}</td>`).join('')}
        </tr>`).join('')}</tbody>
      </table></div>`;
      return;
    }

  },

  games() {
    const listEl = $('#games-list');
    if (!listEl) return;

    // Sync checkboxes with state (survives re-renders)
    const chk = $('#chk-show-finished');
    if (chk) chk.checked = showFinishedGames;
    const myPid = currentUserProfile?.playerId;
    const myTeamIds = myPid
      ? new Set(State.teams.filter(t => (t.playerIds || []).includes(myPid)).map(t => t.id))
      : new Set();
    const lblMy = $('#lbl-my-games');
    const chkMy = $('#chk-my-games');
    if (lblMy) lblMy.style.display = myTeamIds.size ? 'flex' : 'none';
    if (chkMy) chkMy.checked = showMyGamesOnly;

    if (!State.games.length) {
      const hasTwoTeams = State.teams.length >= 2;
      const adminMsg = hasTwoTeams ? 'No games yet.' : 'Create at least 2 teams first.';
      listEl.innerHTML = `<div style="padding:16px;color:#6b7280;font-size:13px">
        ${isAdmin() ? adminMsg : 'No games found.'}
      </div>`;
      return;
    }
    const allSorted = [...State.games].sort((a, b) => b.createdAt - a.createdAt);
    let sorted = showFinishedGames
      ? allSorted
      : allSorted.filter(g => g.status !== 'completed');
    if (showMyGamesOnly && myTeamIds.size) {
      sorted = sorted.filter(g => myTeamIds.has(g.homeTeamId) || myTeamIds.has(g.awayTeamId));
    }

    // If the selected game is now hidden, deselect it
    if (selectedGameId && !sorted.find(g => g.id === selectedGameId)) {
      selectedGameId = null;
      const detail = $('#games-detail');
      if (detail) detail.innerHTML = '';
    }

    if (!sorted.length) {
      const emptyMsg = showMyGamesOnly
        ? `No${showFinishedGames ? '' : ' active'} games for your team. <label style="cursor:pointer;color:#0369a1" onclick="showMyGamesOnly=false;Render.games()">Show all?</label>`
        : `No active games. <label style="cursor:pointer;color:#0369a1" onclick="showFinishedGames=true;Render.games()">Show finished?</label>`;
      listEl.innerHTML = `<div style="padding:16px;color:#6b7280;font-size:13px">${emptyMsg}</div>`;
      return;
    }
    // Keep selectedGameId valid
    if (selectedGameId && !State.getGame(selectedGameId)) selectedGameId = null;
    listEl.innerHTML = sorted.map(g => {
      const home = State.getTeam(g.homeTeamId);
      const away = State.getTeam(g.awayTeamId);
      const date = new Date(g.createdAt).toLocaleDateString();
      const isSetup = g.status === 'setup';
      const isLive  = g.status === 'in_progress';
      const showScore = !isSetup;
      const inningStr = isLive
        ? `${g.currentHalf === 'top' ? 'Top' : 'Bot'} ${g.currentInning}`
        : (g.status === 'completed' ? 'Final' : '');
      const active = g.id === selectedGameId ? 'selected' : '';

      // Event badge (tournament-linked games)
      const eventName = g.tournamentId ? (State.getTournament(g.tournamentId)?.name || g.tournamentName || null) : null;
      const eventBadge = eventName
        ? `<div style="font-size:11px;color:#0369a1;margin-top:2px">📋 ${escapeHtml(eventName)}</div>`
        : '';

      // Scoring lock info for live games
      const lockStale   = isLive && isScoringLockStale(g);
      const lockHolder  = isLive && g.scoringLockedBy ? State.getUser(g.scoringLockedBy) : null;
      const scorerName  = lockHolder && !lockStale ? lockHolder.name || null : null;
      const scoringLine = scorerName
        ? `<div style="font-size:11px;color:#059669;margin-top:3px">🟢 ${escapeHtml(scorerName)} is scoring</div>`
        : lockStale && g.scoringLockedBy
        ? `<div style="font-size:11px;color:#d97706;margin-top:3px">⚠️ Scoring session inactive</div>`
        : '';

      // Setup game actions (scorers only)
      const setupActions = isSetup && canUserScore() ? `
        <div style="display:flex;gap:6px;margin-top:6px" onclick="event.stopPropagation()">
          <button class="btn btn-sm btn-primary" onclick="showSetupModal('${g.id}')">▶ Start Scoring</button>
        </div>` : '';

      // Watch / Resume buttons for live games
      const liveActions = isLive ? `
        <div style="display:flex;gap:6px;margin-top:6px" onclick="event.stopPropagation()">
          <button class="btn btn-sm" onclick="renderLiveGame('${g.id}',true)">👁 Watch</button>
          ${canUserScore() ? `<button class="btn btn-sm btn-primary" onclick="openGameForScoring('${g.id}')">▶ Resume</button>` : ''}
        </div>` : '';

      // Status label
      const statusLabel = isSetup ? 'Not Started'
        : isLive ? `In Progress${inningStr ? ' · ' + inningStr : ''}`
        : g.status === 'completed' ? 'Final'
        : g.status.replace('_', ' ');

      const _gameClickAttr = (isSetup && !canUserScore()) ? 'style="cursor:default;opacity:0.6"' : 'onclick="selectGame(\'' + g.id + '\')"';
      return `<div class="player-list-item game-list-item ${active}" ${_gameClickAttr}>
        <div style="width:100%">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span class="game-card-status status-${g.status}" style="font-size:11px">${statusLabel}</span>
            <span style="font-size:11px;color:#9ca3af">${date}</span>
          </div>
          <div style="font-weight:600;font-size:13px;margin-top:3px">${escapeHtml(away?.name||'?')} @ ${escapeHtml(home?.name||'?')}</div>
          ${showScore ? `<div style="font-size:12px;color:#6b7280">${g.score.away} — ${g.score.home}</div>` : ''}
          ${eventBadge}
          ${scoringLine}
          ${setupActions}
          ${liveActions}
          ${isAdmin() ? `<button class="btn-icon" style="float:right;margin-top:-18px" title="Delete" onclick="event.stopPropagation();deleteGame('${g.id}')">🗑</button>` : ''}
        </div>
      </div>`;
    }).join('');
  }
};

/* ============================================================
   MODAL INFRASTRUCTURE
   ============================================================ */
const Modal = {
  show(html, { wide = false, xl = false, full = false } = {}) {
    const m = $('#modal');
    m.classList.remove('lg', 'xl', 'full');
    if (wide) m.classList.add('lg');
    if (xl) m.classList.add('xl');
    if (full) m.classList.add('full');
    $('#modal-content').innerHTML = html;
    $('#modal-backdrop').classList.add('show');
  },
  hide() {
    $('#modal-backdrop').classList.remove('show');
    $('#modal-content').innerHTML = '';
  }
};
$('#modal-backdrop').addEventListener('click', (e) => {
  if (e.target.id === 'modal-backdrop') Modal.hide();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') Modal.hide();
});

/* ============================================================
   PLAYER MODAL
   ============================================================ */
function showPlayerModal(id = null) {
  const editing = id ? State.getPlayer(id) : null;
  const isSelfEdit = !isAdmin() && currentUserProfile?.playerId === id;
  Modal.show(`
    <div class="modal-header">
      <h3>${editing ? 'Edit player' : 'Add player'}</h3>
      <button class="btn-icon" onclick="Modal.hide()">✕</button>
    </div>
    <form onsubmit="submitPlayer(event, ${editing ? `'${id}'` : 'null'})">
      <div class="modal-body">
        <div class="form-group">
          <label for="player-name">Name</label>
          <input id="player-name" required autofocus value="${escapeHtml(editing?.name || '')}" />
        </div>
        <div class="form-group">
          <label for="player-jersey">Jersey number <span class="muted small">(optional)</span></label>
          <input id="player-jersey" maxlength="4" value="${escapeHtml(editing?.jerseyNumber || '')}" />
        </div>
        ${isSelfEdit ? '<p class="muted small" style="margin:4px 0 0 0">Name and number changes don\'t affect existing game stats.</p>' : ''}
      </div>
      <div class="modal-footer">
        <button type="button" class="btn" onclick="Modal.hide()">Cancel</button>
        <button type="submit" class="btn btn-primary">${editing ? 'Save' : 'Add'}</button>
      </div>
    </form>`);
}
async function submitPlayer(e, id) {
  e.preventDefault();
  if (!isAdminUser() && currentUserProfile?.playerId !== id) { toast('Not authorized', 'error'); return; }
  const data = { name: $('#player-name').value, jerseyNumber: $('#player-jersey').value };
  if (!data.name.trim()) return;
  if (id) await State.updatePlayer(id, data);
  else    await State.addPlayer(data);
  Modal.hide();
  Render.all();
  toast(id ? 'Player updated' : 'Player added', 'success');
}
async function deleteUser(uid) {
  if (!isAdminUser()) return;
  if (uid === currentUser?.uid) { toast('Cannot delete your own account', 'error'); return; }
  if (!confirm('Delete this user? Their linked player (if any) will become a guest.')) return;
  try {
    const linkedPlayer = State.players.find(p => p.userId === uid);
    if (linkedPlayer) {
      linkedPlayer.userId = null;
      linkedPlayer.invitePending = false;
      await Storage.savePlayer(linkedPlayer);
    }
    await State.deleteUser(uid);
    toast('User deleted', 'success');
    Render.users();
  } catch (e) {
    toast('Failed to delete user: ' + e.message, 'error');
  }
}
async function deletePlayer(id) {
  const p = State.getPlayer(id);
  if (!p) return;
  if (!confirm(`Delete player "${p.name}"? They will be removed from all teams.`)) return;
  await State.deletePlayer(id);
  Render.all();
  toast('Player deleted');
}

/* ============================================================
   TEAM MODAL
   ============================================================ */
function _randomTeamColor() {
  const palette = [
    '#dc2626','#ea580c','#d97706','#65a30d','#16a34a','#0d9488',
    '#0284c7','#2563eb','#7c3aed','#9333ea','#c026d3','#db2777',
  ];
  return palette[Math.floor(Math.random() * palette.length)];
}
// Returns the team's saved color, or a stable color derived from the team ID
// so teams without an explicit color still get a consistent non-black display.
function _teamColor(team) {
  if (!team) return '#6b7280';
  if (team.color) return team.color;
  const palette = [
    '#dc2626','#ea580c','#d97706','#65a30d','#16a34a','#0d9488',
    '#0284c7','#2563eb','#7c3aed','#9333ea','#c026d3','#db2777',
  ];
  let h = 0;
  for (let i = 0; i < (team.id || '').length; i++) h = (h * 31 + team.id.charCodeAt(i)) & 0xffff;
  return palette[h % palette.length];
}

function showTeamModal(id = null, forceAdmin = false) {
  const editing = id ? State.getTeam(id) : null;
  if (State.players.length < 2) { toast('Add at least 2 players first', 'error'); return; }
  // Non-admin team members can open the modal for their own team
  const myPid = currentUserProfile?.playerId;
  const isMember = myPid && (editing?.playerIds || []).includes(myPid);
  if (id && !isAdminUser() && !isMember) { toast('Not authorized', 'error'); return; }
  // Full roster editing: always on admin page, otherwise respects the toggle
  const canEditRoster = forceAdmin || isAdmin();
  const selected = new Set(editing?.playerIds || []);
  const playerOptions = [...State.players]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(p => `
      <label class="player-picker-item">
        <input type="checkbox" value="${p.id}" ${selected.has(p.id) ? 'checked' : ''} ${!canEditRoster ? 'disabled' : ''}/>
        <span class="jersey-badge" style="width:24px; height:24px; font-size:11px;">${escapeHtml(p.jerseyNumber || '#')}</span>
        <span>${escapeHtml(p.name)}</span>
      </label>`).join('');
  Modal.show(`
    <div class="modal-header">
      <h3>${editing ? 'Edit team' : 'Add team'}</h3>
      <button class="btn-icon" onclick="Modal.hide()">✕</button>
    </div>
    <form onsubmit="submitTeam(event, ${editing ? `'${id}'` : 'null'}, ${canEditRoster})">
      <div class="modal-body">
        <div class="form-group">
          <label for="team-name">Team name</label>
          <input id="team-name" required autofocus value="${escapeHtml(editing?.name || '')}" />
        </div>
        <div class="form-group">
          <label for="team-color">Team color</label>
          <input type="color" id="team-color" value="${editing ? (editing.color || '#6b7280') : _randomTeamColor()}" style="width:48px;height:36px;padding:2px;cursor:pointer;border-radius:6px;border:1px solid #d1d5db" />
        </div>
        <div class="form-group">
          <label>Roster <span class="muted small">(select 2 or more players${!canEditRoster ? ' — only admins can change roster' : ''})</span></label>
          <div class="player-picker" id="team-player-picker">${playerOptions}</div>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn" onclick="Modal.hide()">Cancel</button>
        <button type="submit" class="btn btn-primary">${editing ? 'Save' : 'Add'}</button>
      </div>
    </form>`);
}
async function submitTeam(e, id, canEditRoster = false) {
  e.preventDefault();
  const existingTeam = id ? State.getTeam(id) : null;
  const myPid = currentUserProfile?.playerId;
  const isMember = myPid && (existingTeam?.playerIds || []).includes(myPid);
  if (!isAdminUser() && !isMember) { toast('Not authorized', 'error'); return; }
  const color = $('#team-color').value;
  // Only update roster if full admin mode was active when modal opened
  const checked = canEditRoster
    ? $$('#team-player-picker input[type=checkbox]:checked').map(cb => cb.value)
    : (existingTeam?.playerIds || []);
  if (checked.length < 2) { toast('Pick at least 2 players', 'error'); return; }
  const data = { name: $('#team-name').value, playerIds: checked, color };
  if (!data.name.trim()) return;
  if (id) await State.updateTeam(id, data);
  else    await State.addTeam(data);
  Modal.hide();
  Render.all();
  toast(id ? 'Team updated' : 'Team added', 'success');
}
async function deleteTeam(id) {
  const t = State.getTeam(id);
  if (!t) return;
  if (!confirm(`Delete team "${t.name}"?`)) return;
  await State.deleteTeam(id);
  Render.all();
  toast('Team deleted');
}

/* ============================================================
   NEW GAME MODAL
   ============================================================ */
function showNewGameModal() {
  if (State.teams.length < 2) { toast('Need at least 2 teams', 'error'); return; }
  const teamOptions = State.teams.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
  Modal.show(`
    <div class="modal-header">
      <h3>New game</h3>
      <button class="btn-icon" onclick="Modal.hide()">✕</button>
    </div>
    <form onsubmit="submitNewGame(event)">
      <div class="modal-body">
        <div class="form-row">
          <div class="form-group">
            <label for="game-away">Away team <span class="muted small">(bats first)</span></label>
            <select id="game-away" required>
              <option value="">— pick —</option>${teamOptions}
            </select>
          </div>
          <div class="form-group">
            <label for="game-home">Home team</label>
            <select id="game-home" required>
              <option value="">— pick —</option>${teamOptions}
            </select>
          </div>
        </div>
        <div class="form-group">
          <label for="game-innings">Number of innings</label>
          <input id="game-innings" type="number" min="1" max="20" value="6" required />
          <div class="help-text">If tied at the end of these innings, extra innings are played.</div>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn" onclick="Modal.hide()">Cancel</button>
        <button type="submit" class="btn btn-primary">Create game</button>
      </div>
    </form>`);
}
async function submitNewGame(e) {
  e.preventDefault();
  const homeTeamId = $('#game-home').value;
  const awayTeamId = $('#game-away').value;
  const numInnings = parseInt($('#game-innings').value, 10) || 6;
  if (!homeTeamId || !awayTeamId) return;
  if (homeTeamId === awayTeamId) { toast('Pick two different teams', 'error'); return; }
  let game;
  try {
    game = await State.addGame({ homeTeamId, awayTeamId, numInnings });
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  Modal.hide();
  selectGame(game.id);
  Render.all();
  toast('Game created', 'success');
}
async function deleteGame(id) {
  if (!confirm('Delete this game?')) return;
  if (id === selectedGameId) deselectGame();
  await State.deleteGame(id);
  Render.all();
  toast('Game deleted');
}

function selectGame(id) {
  selectedGameId = id;
  Render.games();
  openGame(id);
}
function deselectGame() {
  selectedGameId = null;
  LiveGameId = null;
  Render.games();
  const detail = $('#games-detail');
  if (detail) detail.innerHTML = '';
}
function openGame(id) {
  selectedGameId = id;
  const g = State.getGame(id);
  if (!g) return;
  if (g.status === 'setup') {
    switchTab('games');
    Render.games();
    if (canUserScore()) {
      showSetupModal(id);
    } else {
      const detail = $('#games-detail'); if (!detail) return;
      const home = State.getTeam(g.homeTeamId), away = State.getTeam(g.awayTeamId);
      const eventName = g.tournamentId ? (State.getTournament(g.tournamentId)?.name || g.tournamentName || null) : null;
      detail.innerHTML = `
        <div class="inline-game-header">
          <h3>${escapeHtml(away?.name||'?')} @ ${escapeHtml(home?.name||'?')}</h3>
          ${eventName ? `<div style="font-size:12px;color:#0369a1;margin-top:4px">📋 ${escapeHtml(eventName)}</div>` : ''}
        </div>
        <div style="padding:24px;text-align:center;color:#6b7280">
          <div style="font-size:32px;margin-bottom:8px">⏳</div>
          <div style="font-size:15px;font-weight:600;margin-bottom:4px">Not Started</div>
          <div style="font-size:13px">This game hasn't been set up yet.</div>
        </div>`;
    }
  } else {
    renderLiveGame(g.id);
  }
}

/* ============================================================
   TOURNAMENTS
   ============================================================ */
let selectedTournamentId = null;

function selectTournament(id) {
  selectedTournamentId = id;
  Render.tournaments();
}

function tournamentBack() {
  selectedTournamentId = null;
  const split = $('#tournaments-split');
  if (split) split.classList.remove('tourn-has-detail');
  const detail = $('#tournaments-detail');
  if (detail) detail.innerHTML = '';
  // Re-render list to clear selected highlight
  Render.tournaments();
}

function buildChampSection(id, champGame, finalists, useGenerateFn) {
  if (!champGame) {
    const canGenerate = isAdmin() && finalists.length === 2;
    const genFn = useGenerateFn ? `generateTournamentGames('${id}')` : `generateChampionshipGame('${id}')`;
    return `<div class="champ-bracket champ-pending">
      <div class="champ-bracket-label">🏆 Championship</div>
      <div class="champ-finalists">
        <div class="champ-finalist">${escapeHtml(finalists[0]?.name || '?')}</div>
        <div class="champ-vs">vs</div>
        <div class="champ-finalist">${escapeHtml(finalists[1]?.name || '?')}</div>
      </div>
      ${canGenerate ? `<button class="btn btn-primary" style="margin-top:12px" onclick="${genFn}">⚙ Create Championship Game</button>` : ''}
    </div>`;
  }
  const chHome = State.getTeam(champGame.homeTeamId), chAway = State.getTeam(champGame.awayTeamId);
  const isComplete = champGame.status === 'completed';
  let winnerName = '';
  if (isComplete) {
    const w = champGame.score.away > champGame.score.home ? chAway : champGame.score.home > champGame.score.away ? chHome : null;
    winnerName = w ? w.name : 'Tie';
  }
  return `<div class="champ-bracket${isComplete ? ' champ-complete' : ''}">
    <div class="champ-bracket-label">🏆 Championship</div>
    ${isComplete && winnerName ? `<div class="champ-winner">🎉 ${escapeHtml(winnerName)} wins the tournament!</div>` : ''}
    <div class="champ-finalists" style="cursor:pointer" onclick="openGame('${champGame.id}')">
      <div class="champ-finalist${isComplete && champGame.score.away >= champGame.score.home ? ' champ-finalist-winner' : ''}">${escapeHtml(chAway?.name||'?')}</div>
      <div class="champ-score">${isComplete ? `${champGame.score.away}–${champGame.score.home}` : champGame.status.replace('_',' ')}</div>
      <div class="champ-finalist${isComplete && champGame.score.home >= champGame.score.away ? ' champ-finalist-winner' : ''}">${escapeHtml(chHome?.name||'?')}</div>
    </div>
  </div>`;
}

function buildGameListItem(g) {
  const home = State.getTeam(g.homeTeamId), away = State.getTeam(g.awayTeamId);
  const sub = g.status === 'completed' ? `${g.score.away}–${g.score.home} · Final`
            : g.status === 'in_progress' ? 'In Progress'
            : 'Not Started';
  const rowActions = g.status === 'setup' && canUserScore()
    ? `<div style="margin-top:4px" onclick="event.stopPropagation()"><button class="btn btn-sm btn-primary" onclick="showSetupModal('${g.id}')">▶ Start Scoring</button></div>`
    : g.status === 'in_progress'
    ? `<div style="margin-top:4px;display:flex;gap:6px" onclick="event.stopPropagation()">
         <button class="btn btn-sm" onclick="renderLiveGame('${g.id}',true)">👁 Watch</button>
         ${canUserScore() ? `<button class="btn btn-sm btn-primary" onclick="openGameForScoring('${g.id}')">▶ Resume</button>` : ''}
       </div>`
    : '';
  return `<div class="player-list-item" style="cursor:pointer" onclick="openGame('${g.id}')">
    <div class="pli-name">${escapeHtml(away?.name||'?')} @ ${escapeHtml(home?.name||'?')}</div>
    <div class="pli-sub">${sub}</div>
    ${rowActions}
  </div>`;
}

function renderTournamentDetail(id) {
  const detail = $('#tournaments-detail'); if (!detail) return;
  const t = State.getTournament(id);
  if (!t) { detail.innerHTML = '<div class="player-detail-empty"><span>Tournament not found</span></div>'; return; }

  const isDE      = t.format === 'double_elim';
  const isPlayoff = t.format === 'playoff';
  const allGames  = State.games.filter(g => g.tournamentId === id).sort((a, b) => (a.deRound||0) - (b.deRound||0) || a.createdAt - b.createdAt);
  const champGame = allGames.find(g => g.isChampionship);
  const nonChamp  = allGames.filter(g => !g.isChampionship);

  let standingsHtml = '', champSection = '', gamesHtml = '', adminBtn = '';

  // ── Double Elimination ──────────────────────────────────────────────────────
  if (isDE) {
    const standings = State.computeDoubleElimStandings(id);
    const maxRound  = nonChamp.length ? Math.max(...nonChamp.map(g => g.deRound || 1)) : 0;
    const curRoundDone = maxRound === 0 || nonChamp.filter(g => (g.deRound||1) === maxRound).every(g => g.status === 'completed');
    const activeCount  = standings.filter(s => !s.eliminated).length;

    // Standings table
    const deRows = standings.map((row, i) => {
      const badge = row.eliminated ? `<span style="font-size:11px;color:#dc2626;font-weight:600;margin-left:4px">OUT</span>` : '';
      return `<tr class="${i === 0 && !row.eliminated ? 'tourn-leader' : ''}${row.eliminated ? ' tourn-eliminated' : ''}">
        <td>${row.eliminated ? '✗' : i+1}</td>
        <td><strong>${escapeHtml(row.team.name)}</strong>${badge}</td>
        <td>${row.W}</td><td>${row.L}</td><td>${row.gamesPlayed}</td>
      </tr>`;
    }).join('');
    standingsHtml = `<div class="tourn-standings-scroll">
      <table class="stats-table tourn-standings-table" style="width:100%">
        <thead><tr><th>#</th><th>Team</th><th>W</th><th>L</th><th>GP</th></tr></thead>
        <tbody>${deRows}</tbody>
      </table>
    </div>`;

    // Championship section (when 2 active teams remain or champ exists)
    if (champGame) {
      champSection = buildChampSection(id, champGame, []);
    } else if (curRoundDone && activeCount === 2 && maxRound > 0) {
      const finalists = standings.filter(s => !s.eliminated).map(s => s.team);
      champSection = buildChampSection(id, null, finalists, true);
    }

    // Admin button (only show generate for next round; championship creation is in the champ section)
    if (isAdmin()) {
      const showGenBtn = curRoundDone && !champGame && activeCount > 2;
      const nextRound  = maxRound + 1;
      adminBtn = `<div class="tourn-admin-actions">
        ${showGenBtn ? `<button class="btn btn-sm btn-primary" onclick="generateTournamentGames('${id}')">⚙ Generate Round ${nextRound}</button>` : ''}
        <button class="btn-icon" title="Edit" onclick="showTournamentModal('${id}')">✎</button>
        <button class="btn-icon" title="Delete" onclick="deleteTournamentUI('${id}')">🗑</button>
      </div>`;
    }

    // Games grouped by round
    if (nonChamp.length) {
      const rounds = [...new Set(nonChamp.map(g => g.deRound || 1))].sort((a,b) => a-b);
      gamesHtml = rounds.map(r => {
        const rGames = nonChamp.filter(g => (g.deRound||1) === r);
        return `<div class="tourn-section-title" style="margin-top:10px">Round ${r}</div>
          <div class="tourn-games-scroll">${rGames.map(buildGameListItem).join('')}</div>`;
      }).join('');
    } else {
      gamesHtml = `<div class="help-text" style="padding:8px">No games yet. ${isAdmin() ? 'Generate Round 1 to start.' : ''}</div>`;
    }

  // ── Round Robin / Playoff ───────────────────────────────────────────────────
  } else {
    const standings  = State.computeTournamentStandings(id);
    const existingRR = nonChamp.map(g => `${g.homeTeamId}|${g.awayTeamId}`);
    let rrPairsLeft  = 0;
    for (let i=0; i<t.teamIds.length; i++)
      for (let j=i+1; j<t.teamIds.length; j++) {
        const a = t.teamIds[i], b = t.teamIds[j];
        if (!existingRR.includes(`${a}|${b}`) && !existingRR.includes(`${b}|${a}`)) rrPairsLeft++;
      }
    const totalRRPairs = t.teamIds.length * (t.teamIds.length - 1) / 2;
    const rrComplete   = nonChamp.filter(g => g.status === 'completed').length === totalRRPairs;

    // Standings
    const rrRows = standings.map((row, i) => {
      const isFinalist = isPlayoff && i < 2;
      return `<tr class="${i === 0 ? 'tourn-leader' : ''}${isFinalist ? ' tourn-finalist' : ''}">
        <td>${isFinalist ? (i === 0 ? '🥇' : '🥈') : i+1}</td>
        <td><strong>${escapeHtml(row.team.name)}</strong></td>
        <td>${row.W}</td><td>${row.L}</td><td>${row.T}</td>
        <td>${row.pts}</td><td>${row.RF}</td><td>${row.RA}</td>
        <td>${row.rd >= 0 ? '+' : ''}${row.rd}</td>
      </tr>${isPlayoff && i === 1 && standings.length > 2 ? '<tr class="tourn-cutoff-row"><td colspan="9"><span class="tourn-cutoff-label">── advance to finals ──</span></td></tr>' : ''}`;
    }).join('');
    standingsHtml = standings.length
      ? `<div class="tourn-standings-scroll">
          <table class="stats-table tourn-standings-table" style="width:100%">
            <thead><tr><th>#</th><th>Team</th><th>W</th><th>L</th><th>T</th><th>Pts</th><th>RF</th><th>RA</th><th>+/-</th></tr></thead>
            <tbody>${rrRows}</tbody>
          </table>
        </div>`
      : '<div class="help-text" style="margin-bottom:16px">No games played yet.</div>';

    // Championship section (playoff only)
    if (isPlayoff) {
      if (!rrComplete) {
        champSection = `<div class="champ-bracket champ-pending">
          <div class="champ-bracket-label">🏆 Championship</div>
          <div class="help-text">Complete all round-robin games to determine the finalists.</div>
        </div>`;
      } else {
        const finalists = standings.slice(0, 2).map(s => s.team);
        champSection = buildChampSection(id, champGame || null, finalists);
      }
    }

    // Admin button
    if (isAdmin()) {
      adminBtn = `<div class="tourn-admin-actions">
        ${rrPairsLeft > 0 ? `<button class="btn btn-sm btn-primary" onclick="generateTournamentGames('${id}')">⚙ Generate ${rrPairsLeft} game${rrPairsLeft>1?'s':''}</button>` : ''}
        <button class="btn-icon" title="Edit" onclick="showTournamentModal('${id}')">✎</button>
        <button class="btn-icon" title="Delete" onclick="deleteTournamentUI('${id}')">🗑</button>
      </div>`;
    }

    // Games list
    gamesHtml = `<div class="tourn-games-scroll">${nonChamp.length
      ? [...nonChamp].reverse().map(buildGameListItem).join('')
      : '<div class="help-text" style="padding:8px">No round-robin games yet.</div>'
    }</div>`;
  }

  const formatLabel = isDE ? 'Double Elimination' : 'Round Robin';

  const split = $('#tournaments-split');
  if (split) split.classList.add('tourn-has-detail');

  detail.innerHTML = `
    <button class="tourn-back-btn" onclick="tournamentBack()">‹ Events</button>
    <div class="tourn-detail-body">
      <div class="tourn-header-row">
        <div>
          <h3 style="margin:0 0 2px">${escapeHtml(t.name)}</h3>
          <span class="tourn-format-badge">${formatLabel}</span>
        </div>
        ${adminBtn}
      </div>

      ${champSection}

      <div class="tourn-section-title" style="margin-top:14px">Standings</div>
      ${standingsHtml}

      <div class="tourn-section-title">Games</div>
      ${gamesHtml}

      <div class="tourn-section-title" style="margin-top:20px">Player Stats</div>
      <div class="players-subnav" id="tourn-player-subnav">
        <button class="${_tournStatsView === 'batting' ? 'active' : ''}" data-view="batting" onclick="setTournStatsView('${id}','batting')">Batting</button>
        <button class="${_tournStatsView === 'pitching' ? 'active' : ''}" data-view="pitching" onclick="setTournStatsView('${id}','pitching')">Pitching</button>
        <button class="${_tournStatsView === 'fielding' ? 'active' : ''}" data-view="fielding" onclick="setTournStatsView('${id}','fielding')">Fielding</button>
      </div>
      <div id="tourn-player-stats"></div>

      <div class="tourn-section-title" style="margin-top:16px">Team Stats</div>
      <div class="players-subnav" id="tourn-team-subnav">
        <button class="${_tournTeamView === 'batting' ? 'active' : ''}" data-view="batting" onclick="setTournTeamView('${id}','batting')">Batting</button>
        <button class="${_tournTeamView === 'pitching' ? 'active' : ''}" data-view="pitching" onclick="setTournTeamView('${id}','pitching')">Pitching</button>
      </div>
      <div id="tourn-team-stats"></div>
    </div>`;

  renderTournPlayerStats(id);
  renderTournTeamStats(id);
}

function showNewTournamentModal() {
  const teamOpts = State.teams.map(t =>
    `<label class="tourn-team-opt">
       <input type="checkbox" name="tourn-team" value="${t.id}"> ${escapeHtml(t.name)}
     </label>`).join('');
  Modal.show(`
    <div class="modal-header">
      <h2>New Event</h2>
      <button class="btn-icon" onclick="Modal.hide()">✕</button>
    </div>
    <div class="modal-body">
      <div class="form-row">
        <label>Event name</label>
        <input type="text" id="tourn-name" placeholder="e.g. Summer Classic 2025">
      </div>
      <div class="form-row">
        <label>Format</label>
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:4px">
          <label class="tourn-team-opt">
            <input type="radio" name="tourn-format" value="double_elim" checked>
            <div>
              <strong>Double Elimination</strong>
              <div class="help-text">Teams are eliminated after 2 losses. Games are played in rounds. Last 2 teams meet in a championship.</div>
            </div>
          </label>
          <label class="tourn-team-opt">
            <input type="radio" name="tourn-format" value="playoff">
            <div>
              <strong>Round Robin</strong>
              <div class="help-text">All teams play each other. Top 2 records advance to a championship game. Tiebreaker: fewest runs allowed.</div>
            </div>
          </label>
        </div>
      </div>
      <div class="form-row">
        <label>Teams (select 2 or more)</label>
        <div>${teamOpts || '<span class="help-text">Add teams first.</span>'}</div>
      </div>
    </div>
    <div class="modal-footer">
      <button type="button" class="btn" onclick="Modal.hide()">Cancel</button>
      <button type="button" class="btn btn-primary" onclick="submitNewTournament()">Create</button>
    </div>`);
}

async function submitNewTournament() {
  const name    = $('#tourn-name')?.value.trim();
  const format  = $('input[name="tourn-format"]:checked')?.value || 'double_elim';
  const teamIds = $$('input[name="tourn-team"]:checked').map(cb => cb.value);
  if (!name) { toast('Enter an event name', 'error'); return; }
  if (teamIds.length < 2) { toast('Select at least 2 teams', 'error'); return; }
  if (format === 'double_elim' && teamIds.length < 3) { toast('Double Elimination needs at least 3 teams', 'error'); return; }
  if (format === 'playoff' && teamIds.length < 3) { toast('Round Robin format needs at least 3 teams', 'error'); return; }
  // Ensure no two selected teams share a player
  const selectedTeams = teamIds.map(id => State.getTeam(id)).filter(Boolean);
  const conflicts = [];
  for (let i = 0; i < selectedTeams.length; i++) {
    for (let j = i + 1; j < selectedTeams.length; j++) {
      const a = selectedTeams[i], b = selectedTeams[j];
      const shared = (a.playerIds || []).filter(pid => (b.playerIds || []).includes(pid));
      if (shared.length) {
        const names = shared.map(pid => State.getPlayer(pid)?.name || pid).join(', ');
        conflicts.push(`${escapeHtml(a.name)} & ${escapeHtml(b.name)} share: ${names}`);
      }
    }
  }
  if (conflicts.length) {
    toast('Teams share players — ' + conflicts.join('; '), 'error');
    return;
  }
  try {
    const t = await State.addTournament({ name, teamIds, format });
    Modal.hide();
    selectedTournamentId = t.id;
    Render.tournaments();
    switchTab('tournaments');
    toast('Event created!', 'success');
    await generateTournamentGames(t.id);
  } catch (err) {
    toast('Failed to create event: ' + (err.message || err), 'error');
  }
}

function generateDEPairings(activeTeams, existingPairSet) {
  // Shuffle teams
  const teams = [...activeTeams];
  for (let i = teams.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [teams[i], teams[j]] = [teams[j], teams[i]];
  }

  let byeTeam = null;
  let pool = [...teams];

  if (pool.length % 2 !== 0) {
    // Bye: prefer team with most games played (not behind)
    const maxGP = Math.max(...pool.map(t => t.gamesPlayed));
    const byeCandidates = pool.filter(t => t.gamesPlayed === maxGP);
    byeTeam = byeCandidates[Math.floor(Math.random() * byeCandidates.length)];
    pool = pool.filter(t => t.id !== byeTeam.id);
  }

  // Greedy pairing — prefer no rematch, fall back to any available
  const pairs = [];
  const usedIdx = new Set();

  for (let i = 0; i < pool.length; i++) {
    if (usedIdx.has(i)) continue;
    const a = pool[i];
    let foundJ = -1;
    // First pass: no rematch
    for (let j = i + 1; j < pool.length; j++) {
      if (usedIdx.has(j)) continue;
      const b = pool[j];
      if (!existingPairSet.has(`${a.id}|${b.id}`) && !existingPairSet.has(`${b.id}|${a.id}`)) {
        foundJ = j; break;
      }
    }
    // Second pass: any available (relaxed)
    if (foundJ < 0) {
      for (let j = i + 1; j < pool.length; j++) {
        if (!usedIdx.has(j)) { foundJ = j; break; }
      }
    }
    if (foundJ >= 0) {
      pairs.push([a.id, pool[foundJ].id]);
      usedIdx.add(i);
      usedIdx.add(foundJ);
    }
  }
  return { pairs, byeTeam };
}

async function generateTournamentGames(tournId) {
  const t = State.getTournament(tournId); if (!t) return;

  if (t.format === 'double_elim') {
    const deGames = State.games.filter(g => g.tournamentId === tournId && !g.isChampionship);
    const maxRound = deGames.length ? Math.max(...deGames.map(g => g.deRound || 1)) : 0;

    // Must finish current round before generating the next
    if (maxRound > 0) {
      const curRoundGames = deGames.filter(g => (g.deRound || 1) === maxRound);
      if (!curRoundGames.every(g => g.status === 'completed')) {
        toast('Finish all games in the current round first', 'error'); return;
      }
    }

    // Compute losses from completed games
    const losses = {}, wins = {};
    t.teamIds.forEach(id => { losses[id] = 0; wins[id] = 0; });
    deGames.filter(g => g.status === 'completed').forEach(g => {
      const homeWon = g.score.home > g.score.away;
      if (homeWon) { wins[g.homeTeamId]++; losses[g.awayTeamId]++; }
      else if (g.score.away > g.score.home) { wins[g.awayTeamId]++; losses[g.homeTeamId]++; }
    });

    const activeTeams = t.teamIds
      .filter(id => (losses[id] || 0) < 2)
      .map(id => ({ id, gamesPlayed: (wins[id]||0) + (losses[id]||0), losses: losses[id]||0 }));

    if (activeTeams.length < 2) { toast('Not enough active teams', 'error'); return; }

    // Exactly 2 active teams → championship
    if (activeTeams.length === 2) {
      const champGame = State.games.find(g => g.tournamentId === tournId && g.isChampionship);
      if (champGame) { toast('Championship game already exists', 'error'); return; }
      const [a, b] = activeTeams;
      await State.addGame({ homeTeamId: a.id, awayTeamId: b.id, numInnings: 6, tournamentId: tournId, isChampionship: true, allowSharedPlayers: true });
      Render.all();
      renderTournamentDetail(tournId);
      toast('Championship game created!', 'success');
      return;
    }

    const nextRound = maxRound + 1;
    const existingPairSet = new Set(deGames.map(g => `${g.homeTeamId}|${g.awayTeamId}`));
    const { pairs, byeTeam } = generateDEPairings(activeTeams, existingPairSet);

    if (!pairs.length) { toast('Could not generate matchups', 'error'); return; }

    await Promise.all(pairs.map(([homeId, awayId]) =>
      State.addGame({ homeTeamId: homeId, awayTeamId: awayId, numInnings: 6, tournamentId: tournId, deRound: nextRound, allowSharedPlayers: true })
    ));
    Render.all();
    renderTournamentDetail(tournId);
    const byeMsg = byeTeam ? ` · ${State.getTeam(byeTeam.id)?.name || 'one team'} has a bye` : '';
    toast(`Round ${nextRound}: ${pairs.length} game${pairs.length>1?'s':''} generated${byeMsg}`, 'success');
    return;
  }

  // Round Robin / Playoff: generate all unplayed pairs at once
  const existing = State.games.filter(g => g.tournamentId === tournId && !g.isChampionship)
    .map(g => `${g.homeTeamId}|${g.awayTeamId}`);
  const pairs = [];
  for (let i=0; i<t.teamIds.length; i++)
    for (let j=i+1; j<t.teamIds.length; j++) {
      const a = t.teamIds[i], b = t.teamIds[j];
      if (!existing.includes(`${a}|${b}`) && !existing.includes(`${b}|${a}`))
        pairs.push([a, b]);
    }
  if (!pairs.length) { toast('All round-robin matchups already generated', 'error'); return; }
  await Promise.all(pairs.map(([homeId, awayId]) =>
    State.addGame({ homeTeamId: homeId, awayTeamId: awayId, numInnings: 6, tournamentId: tournId, allowSharedPlayers: true })
  ));
  Render.all();
  renderTournamentDetail(tournId);
  toast(`${pairs.length} game${pairs.length>1?'s':''} generated`, 'success');
}

async function generateChampionshipGame(tournId) {
  const t = State.getTournament(tournId); if (!t) return;
  const standings = State.computeTournamentStandings(tournId);
  if (standings.length < 2) { toast('Not enough teams in standings', 'error'); return; }
  const [first, second] = standings;
  const game = await State.addGame({
    homeTeamId: first.team.id, awayTeamId: second.team.id,
    numInnings: 6, tournamentId: tournId, isChampionship: true, allowSharedPlayers: true,
  });
  Render.all();
  renderTournamentDetail(tournId);
  toast('Championship game created!', 'success');
}

// Called automatically after a tournament game completes.
// Silently checks conditions and triggers the next round or championship.
async function autoGenerateTournamentRound(tournId) {
  const t = State.getTournament(tournId); if (!t) return;

  if (t.format === 'double_elim') {
    const deGames = State.games.filter(g => g.tournamentId === tournId && !g.isChampionship);
    if (!deGames.length) return;
    const maxRound = Math.max(...deGames.map(g => g.deRound || 1));
    const curRoundGames = deGames.filter(g => (g.deRound || 1) === maxRound);
    if (!curRoundGames.every(g => g.status === 'completed')) return;
    const champExists = State.games.some(g => g.tournamentId === tournId && g.isChampionship);
    if (champExists) return;
    await generateTournamentGames(tournId);

  } else if (t.format === 'playoff') {
    const nonChamp = State.games.filter(g => g.tournamentId === tournId && !g.isChampionship);
    const totalPairs = t.teamIds.length * (t.teamIds.length - 1) / 2;
    if (nonChamp.filter(g => g.status === 'completed').length < totalPairs) return;
    const champExists = State.games.some(g => g.tournamentId === tournId && g.isChampionship);
    if (champExists) return;
    await generateChampionshipGame(tournId);
  }
}

function showTournamentModal(id) {
  const t = State.getTournament(id); if (!t) return;
  Modal.show(`
    <div class="modal-header">
      <h3>Edit event</h3>
      <button class="btn-icon" onclick="Modal.hide()">✕</button>
    </div>
    <form onsubmit="submitTournament(event,'${id}')">
      <div class="modal-body">
        <div class="form-group">
          <label for="tourn-edit-name">Event name</label>
          <input id="tourn-edit-name" required autofocus value="${escapeHtml(t.name)}" />
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn" onclick="Modal.hide()">Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>`);
}
async function submitTournament(e, id) {
  e.preventDefault();
  const name = $('#tourn-edit-name')?.value.trim();
  if (!name) { toast('Enter an event name', 'error'); return; }
  await State.updateTournament(id, { name });
  Modal.hide();
  Render.all();
  if (selectedTournamentId === id) renderTournamentDetail(id);
  toast('Event updated', 'success');
}

async function deleteTournamentUI(id) {
  const t = State.getTournament(id); if (!t) return;
  const unstartedGames = State.games.filter(g => g.tournamentId === id && g.status === 'setup');
  const msg = unstartedGames.length
    ? `Delete "${t.name}"? ${unstartedGames.length} unstarted game${unstartedGames.length > 1 ? 's' : ''} will be removed. Finished games are kept.`
    : `Delete "${t.name}"? All finished games will be kept.`;
  if (!confirm(msg)) return;
  await Promise.all(unstartedGames.map(g => State.deleteGame(g.id)));
  selectedTournamentId = null;
  await State.deleteTournament(id);
  Render.all();
  const detail = $('#tournaments-detail');
  if (detail) detail.innerHTML = '';
  toast('Event deleted');
}

/* ============================================================
   GAME SETUP SCREEN (lineup + positions, then Start)
   ============================================================ */
function renderGameSetup(g) {
  const home = State.getTeam(g.homeTeamId);
  const away = State.getTeam(g.awayTeamId);
  if (!home || !away) { toast('Game has missing teams', 'error'); return; }
  const detail = $('#games-detail');
  if (!detail) return;
  detail.innerHTML = `
    <div class="inline-game-header">
      <h3>${escapeHtml(away.name)} @ ${escapeHtml(home.name)}
        <span class="game-card-status status-setup" style="margin-left:8px">setup</span>
      </h3>
    </div>
    <div style="padding:0 20px 8px">
      <p class="help-text" style="margin-bottom:18px">
        Set the batting order (drag the ⋮⋮ handle or use ↑/↓) and assign starting field positions.
        Batting order stays fixed once the game starts; positions can be changed any time during the game.
      </p>
      <div class="game-setup-grid">
        <div class="lineup-team-block">
          <h4>${escapeHtml(away.name)} <span class="team-tag away">Away</span></h4>
          <ul class="lineup-list" id="lineup-away" data-team="away" data-game="${g.id}"></ul>
        </div>
        <div class="lineup-team-block">
          <h4>${escapeHtml(home.name)} <span class="team-tag">Home</span></h4>
          <ul class="lineup-list" id="lineup-home" data-team="home" data-game="${g.id}"></ul>
        </div>
      </div>
    </div>
    <div style="padding:12px 20px;border-top:1px solid #e5e7eb;display:flex;gap:8px;justify-content:flex-end">
      <button class="btn btn-primary" onclick="startGame('${g.id}')">Start game →</button>
    </div>`;
  renderLineup(g, 'away');
  renderLineup(g, 'home');
}

function showSetupModal(gameId) {
  const g = State.getGame(gameId); if (!g) return;
  const home = State.getTeam(g.homeTeamId), away = State.getTeam(g.awayTeamId);
  if (!home || !away) { toast('Game has missing teams', 'error'); return; }
  const eventName = g.tournamentId ? (State.getTournament(g.tournamentId)?.name || g.tournamentName || null) : null;
  Modal.show(`
    <div class="modal-header">
      <div>
        <h2 style="margin:0">${escapeHtml(away.name)} @ ${escapeHtml(home.name)}</h2>
        ${eventName ? `<div style="font-size:12px;color:#0369a1;margin-top:2px">📋 ${escapeHtml(eventName)}</div>` : ''}
      </div>
      <button class="btn-icon" onclick="Modal.hide()">✕</button>
    </div>
    <div class="modal-body" style="padding:12px 16px 0">
      <p class="help-text" style="margin-bottom:14px">
        Set the batting order and assign starting positions. Batting order is fixed once the game starts.
      </p>
      <div class="game-setup-grid">
        <div class="lineup-team-block">
          <h4>${escapeHtml(away.name)} <span class="team-tag away">Away</span></h4>
          <ul class="lineup-list" id="lineup-away" data-team="away" data-game="${g.id}"></ul>
        </div>
        <div class="lineup-team-block">
          <h4>${escapeHtml(home.name)} <span class="team-tag">Home</span></h4>
          <ul class="lineup-list" id="lineup-home" data-team="home" data-game="${g.id}"></ul>
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="Modal.hide()">Cancel</button>
      <button class="btn btn-primary" onclick="startGame('${g.id}')">Start Game →</button>
    </div>`, { wide: true });
  renderLineup(g, 'away');
  renderLineup(g, 'home');
}

function renderLineup(g, side) {
  const team = side === 'home' ? State.getTeam(g.homeTeamId) : State.getTeam(g.awayTeamId);
  const order = side === 'home' ? g.homeBattingOrder : g.awayBattingOrder;
  const positions = side === 'home' ? g.homePositions : g.awayPositions;
  const list = $('#lineup-' + side);
  if (!list) return;

  const positionOptions = (currentPos) => {
    const opts = [
      { v: 'P', label: 'Pitcher (P)' },
      { v: 'CF', label: 'Center Field (CF)' },
    ];
    if (team.playerIds.length >= 3) opts.push({ v: 'EH', label: 'Extra Hitter (EH)' });
    opts.push({ v: 'BENCH', label: 'Bench' });
    return opts.map(o => `<option value="${o.v}" ${o.v === currentPos ? 'selected' : ''}>${o.label}</option>`).join('');
  };

  list.innerHTML = order.map((pid, idx) => {
    const p = State.getPlayer(pid); if (!p) return '';
    const pos = positions[pid] || 'BENCH';
    return `<li class="lineup-row" draggable="true" data-pid="${pid}">
      <span class="lineup-handle" title="Drag to reorder">⋮⋮</span>
      <span class="lineup-order">${idx + 1}</span>
      <span class="lineup-name">
        <span class="num">#${escapeHtml(p.jerseyNumber || '-')}</span>
        ${escapeHtml(p.name)}
      </span>
      <select onchange="setPosition('${g.id}', '${side}', '${pid}', this.value)">${positionOptions(pos)}</select>
      <button class="btn-icon btn-sm" title="Move up" onclick="moveBatter('${g.id}', '${side}', ${idx}, -1)">↑</button>
      <button class="btn-icon btn-sm" title="Move down" onclick="moveBatter('${g.id}', '${side}', ${idx}, 1)">↓</button>
    </li>`;
  }).join('');

  // Drag & drop reordering
  let draggedIdx = null;
  list.querySelectorAll('.lineup-row').forEach((row, idx) => {
    row.addEventListener('dragstart', (e) => {
      draggedIdx = idx;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      list.querySelectorAll('.drop-target').forEach(r => r.classList.remove('drop-target'));
    });
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      list.querySelectorAll('.drop-target').forEach(r => r.classList.remove('drop-target'));
      row.classList.add('drop-target');
    });
    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      if (draggedIdx === null || draggedIdx === idx) return;
      const arr = [...order];
      const [moved] = arr.splice(draggedIdx, 1);
      arr.splice(idx, 0, moved);
      const patch = side === 'home' ? { homeBattingOrder: arr } : { awayBattingOrder: arr };
      await State.updateGame(g.id, patch);
      const fresh = State.getGame(g.id);
      renderLineup(fresh, side);
    });
  });
}

async function setPosition(gameId, side, playerId, position) {
  const g = State.getGame(gameId); if (!g) return;
  const positions = side === 'home' ? { ...g.homePositions } : { ...g.awayPositions };
  positions[playerId] = position;
  if (position === 'P' || position === 'CF') {
    Object.keys(positions).forEach(pid => {
      if (pid !== playerId && positions[pid] === position) positions[pid] = 'BENCH';
    });
  }
  const patch = side === 'home' ? { homePositions: positions } : { awayPositions: positions };
  await State.updateGame(gameId, patch);
  const fresh = State.getGame(gameId);
  renderLineup(fresh, side);
}

async function moveBatter(gameId, side, idx, delta) {
  const g = State.getGame(gameId); if (!g) return;
  const order = [...(side === 'home' ? g.homeBattingOrder : g.awayBattingOrder)];
  const newIdx = idx + delta;
  if (newIdx < 0 || newIdx >= order.length) return;
  [order[idx], order[newIdx]] = [order[newIdx], order[idx]];
  const patch = side === 'home' ? { homeBattingOrder: order } : { awayBattingOrder: order };
  await State.updateGame(gameId, patch);
  const fresh = State.getGame(gameId);
  renderLineup(fresh, side);
}

// Build a pitching rotation for one team: start from current pitcher, wrap through batting order
function buildPitchingOrder(battingOrder, positions) {
  const starterIdx = battingOrder.findIndex(pid => positions[pid] === 'P');
  if (starterIdx < 0) return [...battingOrder]; // fallback
  return [
    ...battingOrder.slice(starterIdx),
    ...battingOrder.slice(0, starterIdx),
  ];
}

async function startGame(gameId) {
  const g = State.getGame(gameId); if (!g) return;
  const checkPositions = (team, positions, teamName) => {
    const hasP = team.playerIds.some(pid => positions[pid] === 'P');
    const hasCF = team.playerIds.some(pid => positions[pid] === 'CF');
    if (!hasP) { toast(`${teamName} needs a Pitcher assigned`, 'error'); return false; }
    if (!hasCF) { toast(`${teamName} needs a Center Fielder assigned`, 'error'); return false; }
    return true;
  };
  const home = State.getTeam(g.homeTeamId), away = State.getTeam(g.awayTeamId);
  if (!checkPositions(home, g.homePositions, home.name)) return;
  if (!checkPositions(away, g.awayPositions, away.name)) return;

  // Build pitching rotations from the batting order, starting at the assigned pitcher
  const homePitchingOrder = buildPitchingOrder(g.homeBattingOrder, g.homePositions);
  const awayPitchingOrder = buildPitchingOrder(g.awayBattingOrder, g.awayPositions);

  await State.updateGame(gameId, {
    status: 'in_progress',
    homePitchingOrder,
    awayPitchingOrder,
    homePitcherIdx: 0,
    awayPitcherIdx: 0,
    homeBattersFaced: 0,
    awayBattersFaced: 0,
  });
  Modal.hide();
  Render.games();
  renderLiveGame(gameId);
}

/* ============================================================
   EMAILJS — recap delivery
   ============================================================ */
function getEmailConfig() {
  try { return JSON.parse(localStorage.getItem('wc_ejs') || 'null'); } catch (e) { return null; }
}
function saveEmailConfig(cfg) {
  localStorage.setItem('wc_ejs', JSON.stringify(cfg));
}

function _toggleEmailSetup() {
  const wrap = document.getElementById('ejs-setup-wrap');
  if (wrap) wrap.style.display = wrap.style.display === 'none' ? 'block' : 'none';
}

function showEmailSetupModal() {
  const cfg = getEmailConfig() || {};
  Modal.show(`
    <div class="modal-header">
      <h3>Email Setup (EmailJS)</h3>
      <button class="btn-icon" onclick="Modal.hide()">✕</button>
    </div>
    <div class="modal-body">
      <p class="help-text" style="margin-bottom:12px">Enter your <a href="https://www.emailjs.com/" target="_blank">EmailJS</a> credentials. These are saved locally and never sent to any server.</p>
      <label class="form-label">Service ID</label>
      <input class="form-input" id="ejs-service" placeholder="service_xxxxxxx" value="${escapeHtml(cfg.serviceId || '')}" />
      <label class="form-label">Public Key</label>
      <input class="form-input" id="ejs-key" placeholder="your_public_key" value="${escapeHtml(cfg.publicKey || '')}" />

      <div style="margin-top:16px;margin-bottom:6px;font-size:13px;font-weight:700;color:#374151;border-top:1px solid #e5e7eb;padding-top:14px">Invite Template</div>
      <p class="help-text" style="margin-bottom:8px">Used when inviting a player by email. Variables: <code>{{to_email}}</code>, <code>{{to_name}}</code>, <code>{{message}}</code></p>
      <label class="form-label">Invite Template ID</label>
      <input class="form-input" id="ejs-template" placeholder="template_xxxxxxx" value="${escapeHtml(cfg.templateId || '')}" />

      <div style="margin-top:16px;margin-bottom:6px;font-size:13px;font-weight:700;color:#374151;border-top:1px solid #e5e7eb;padding-top:14px">Recap Template</div>
      <p class="help-text" style="margin-bottom:8px">Used for game recap emails. Create a <strong>separate</strong> template in EmailJS with these settings:</p>
      <ul class="help-text" style="margin:0 0 10px;padding-left:18px;line-height:1.8">
        <li>Subject: <code>{{subject}}</code></li>
        <li>Content type: <strong>HTML</strong></li>
        <li>Body: <code>{{{html_message}}}</code> &nbsp;(triple braces = raw HTML)</li>
      </ul>
      <label class="form-label">Recap Template ID</label>
      <input class="form-input" id="ejs-recap-template" placeholder="template_xxxxxxx" value="${escapeHtml(cfg.recapTemplateId || '')}" />
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="Modal.hide()">Cancel</button>
      <button class="btn btn-primary" onclick="_saveEmailSetup()">Save</button>
    </div>`);
}

function _saveEmailSetup() {
  const serviceId        = document.getElementById('ejs-service')?.value.trim();
  const templateId       = document.getElementById('ejs-template')?.value.trim();
  const publicKey        = document.getElementById('ejs-key')?.value.trim();
  const recapTemplateId  = document.getElementById('ejs-recap-template')?.value.trim() || '';
  if (!serviceId || !publicKey) { toast('Service ID and Public Key are required', 'error'); return; }
  saveEmailConfig({ serviceId, templateId, publicKey, recapTemplateId });
  toast('Email settings saved', 'success');
  Modal.hide();
}

async function sendRecapEmails(gameId) {
  const cfg = getEmailConfig();
  if (!cfg) { showEmailSetupModal(); return; }
  if (!cfg.recapTemplateId) {
    toast('No recap template configured — open email settings and add a Recap Template ID.', 'error');
    showEmailSetupModal();
    return;
  }
  const g = State.getGame(gameId); if (!g) return;
  const home = State.getTeam(g.homeTeamId), away = State.getTeam(g.awayTeamId);
  const allPids = [...new Set([...(home?.playerIds || []), ...(away?.playerIds || [])])];
  const players = allPids.map(pid => State.getPlayer(pid)).filter(p => p?.email);
  if (!players.length) { toast('No players have email addresses on file', 'error'); return; }

  try { emailjs.init(cfg.publicKey); } catch (e) { toast('EmailJS init failed: ' + e.message, 'error'); return; }

  const plainText = buildRecapText(g);
  const subject = away.name + ' @ ' + home.name + ' — WiffleCast Recap';
  let sent = 0, failed = 0;
  const btn = document.getElementById('btn-send-recap');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

  for (const p of players) {
    try {
      await emailjs.send(cfg.serviceId, cfg.recapTemplateId, {
        to_email: p.email,
        to_name:  p.name || p.email,
        subject,
        message:      plainText,
        html_message: buildRecapHtml(g, p.name || ''),
      });
      sent++;
    } catch (e) {
      console.warn('EmailJS send failed for', p.email, e);
      failed++;
    }
  }

  if (btn) { btn.disabled = false; btn.textContent = '📧 Email Recap'; }
  toast(sent + ' recap email' + (sent !== 1 ? 's' : '') + ' sent' + (failed ? ', ' + failed + ' failed' : ''), sent ? 'success' : 'error');
}

/* Auto-send recap to all users linked to players in the game when a game finishes */
async function autoSendRecapEmails(gameId) {
  const cfg = getEmailConfig();
  if (!cfg || !cfg.recapTemplateId) return; // recap template not configured — skip silently
  const g = State.getGame(gameId); if (!g) return;
  const home = State.getTeam(g.homeTeamId), away = State.getTeam(g.awayTeamId);
  const allPids = new Set([...(home?.playerIds || []), ...(away?.playerIds || [])]);
  // Only email users who have a linked player in this game
  const recipients = State.users
    .filter(u => u.playerId && allPids.has(u.playerId) && u.email)
    .map(u => ({ email: u.email, name: u.name || u.email }));
  if (!recipients.length) return;
  try { emailjs.init(cfg.publicKey); } catch (e) { return; }
  const plainText = buildRecapText(g);
  const subject = away.name + ' @ ' + home.name + ' — WiffleCast Recap';
  let sent = 0, failed = 0;
  for (const r of recipients) {
    try {
      await emailjs.send(cfg.serviceId, cfg.recapTemplateId, {
        to_email:     r.email,
        to_name:      r.name,
        subject,
        message:      plainText,
        html_message: buildRecapHtml(g, r.name),
      });
      sent++;
    } catch (e) {
      console.warn('Recap email failed for', r.email, e);
      failed++;
    }
  }
  if (sent) toast(sent + ' recap email' + (sent !== 1 ? 's' : '') + ' sent', 'success');
  if (failed) console.warn('autoSendRecapEmails: ' + failed + ' failed');
}

function showRecapModal(gameId) {
  const g = State.getGame(gameId); if (!g) return;
  const text = buildRecapText(g);
  const canShare = !!navigator.share;
  Modal.show(`
    <div class="modal-header">
      <h2>Game Recap</h2>
      <button class="btn-icon" onclick="Modal.hide()">✕</button>
    </div>
    <div class="modal-body">
      <pre id="recap-text" style="font-size:12px;line-height:1.6;white-space:pre-wrap;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px;margin:0;max-height:340px;overflow-y:auto">${escapeHtml(text)}</pre>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="Modal.hide()">Close</button>
      <button class="btn" id="btn-send-recap" onclick="sendRecapEmails('${gameId}')">📧 Email Recap</button>
      ${canShare ? `<button class="btn btn-primary" onclick="_shareRecap('${gameId}')">Share…</button>` : ''}
      <button class="btn btn-primary" onclick="_copyRecap('${gameId}')">Copy</button>
    </div>
    <div style="text-align:center;margin-top:8px;font-size:12px;color:#6b7280">
      <a href="#" onclick="showEmailSetupModal();return false">Configure email settings</a>
    </div>`);
}

function _copyRecap(gameId) {
  const g = State.getGame(gameId); if (!g) return;
  const text = buildRecapText(g);
  navigator.clipboard.writeText(text).then(() => toast('Recap copied!', 'success')).catch(() => {
    const el = document.getElementById('recap-text');
    if (el) { const r = document.createRange(); r.selectNode(el); window.getSelection().removeAllRanges(); window.getSelection().addRange(r); }
    toast('Press Ctrl+C to copy', 'error');
  });
}

async function _shareRecap(gameId) {
  const g = State.getGame(gameId); if (!g) return;
  const home = State.getTeam(g.homeTeamId), away = State.getTeam(g.awayTeamId);
  try {
    await navigator.share({
      title: `${away.name} @ ${home.name} — WiffleCast Recap`,
      text: buildRecapText(g),
    });
  } catch (e) { if (e.name !== 'AbortError') toast('Could not share: ' + e.message, 'error'); }
}

/* ============================================================
   LINE SCORE
   ============================================================ */
function renderLineScore(g, away, home) {
  const innings = Math.max(g.numInnings, g.lineScore?.length || 0, g.currentInning);
  const ls = g.lineScore || [];
  const headerCells = [];
  for (let i = 1; i <= innings; i++) headerCells.push(`<th>${i}</th>`);
  const awayCells = [], homeCells = [];
  for (let i = 1; i <= innings; i++) {
    const entry = ls.find(x => x.inning === i);
    const topVal  = entry ? entry.top    : '';
    // Don't show bottom if not yet played
    const botVal  = (!entry || (i === g.currentInning && g.currentHalf === 'top' && g.status !== 'completed'))
      ? '' : entry.bottom;
    awayCells.push(`<td>${topVal === '' ? '-' : topVal}</td>`);
    homeCells.push(`<td>${botVal === '' ? '-' : botVal}</td>`);
  }
  return `<table>
    <thead><tr><th></th>${headerCells.join('')}<th>R</th></tr></thead>
    <tbody>
      <tr><td class="team">${escapeHtml(away.name)}</td>${awayCells.join('')}<td class="total">${g.score.away}</td></tr>
      <tr><td class="team">${escapeHtml(home.name)}</td>${homeCells.join('')}<td class="total">${g.score.home}</td></tr>
    </tbody>
  </table>`;
}

/* ============================================================
   TAB NAVIGATION + WIRE-UP
   ============================================================ */
function switchTab(view) {
  _currentTab = view;
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
}
$$('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.view));
});

// btn-add-player and btn-add-team are dynamically rendered — no static listeners needed
$('#btn-add-game').addEventListener('click', () => showNewGameModal());
$('#btn-add-tournament').addEventListener('click', () => showNewTournamentModal());

$('#btn-sign-in').addEventListener('click', () => showAuthModal('signin'));
$('#btn-sign-out').addEventListener('click', () => { closeUserMenu(); signOutUser(); });

// Close user menu when clicking outside
document.addEventListener('click', e => {
  if (!e.target.closest('#user-menu-wrap')) closeUserMenu();
}, true);

// Export / import live in the Admin tab — attach via event delegation so they
// work regardless of when the admin tab is first rendered.
document.addEventListener('click', e => {
  if (e.target.id === 'btn-export') Storage.exportJson();
  if (e.target.id === 'btn-import') $('#import-file')?.click();
});
document.addEventListener('change', async e => {
  if (e.target.id !== 'import-file') return;
  const f = e.target.files[0]; if (!f) return;
  if (!confirm('Importing will replace your current data. Continue?')) { e.target.value = ''; return; }
  try { await Storage.importJson(f); }
  catch (err) { toast('Import failed: ' + err.message, 'error'); }
  e.target.value = '';
});

/* ============================================================
   BOOT
   ============================================================ */
async function migrateGames() {
  const saves = [];
  State.games.forEach(g => {
    let changed = false;
    if (g.numInnings   === undefined) { g.numInnings   = 7;                            changed = true; }
    if (g.score        === undefined) { g.score        = { home: 0, away: 0 };         changed = true; }
    if (g.lineScore    === undefined) { g.lineScore    = [];                            changed = true; }
    if (g.outs         === undefined) { g.outs         = 0;                             changed = true; }
    if (g.balls        === undefined) { g.balls        = 0;                             changed = true; }
    if (g.strikes      === undefined) { g.strikes      = 0;                             changed = true; }
    if (g.fouls        === undefined) { g.fouls        = 0;                             changed = true; }
    if (g.bases        === undefined) { g.bases        = { 1: null, 2: null, 3: null }; changed = true; }
    if (g.runnerCounter=== undefined) { g.runnerCounter= 0;                             changed = true; }
    if (g.homeBatterIdx=== undefined) { g.homeBatterIdx= 0;                             changed = true; }
    if (g.awayBatterIdx=== undefined) { g.awayBatterIdx= 0;                             changed = true; }
    if (g.currentInning=== undefined) { g.currentInning= 1;                             changed = true; }
    if (g.currentHalf  === undefined) { g.currentHalf  = 'top';                         changed = true; }
    if (g.events       === undefined) { g.events       = [];                             changed = true; }
    // Backfill tournamentName so games show their event name without requiring
    // the tournaments collection to be readable (important for public/unauth users).
    if (g.tournamentId && !g.tournamentName) {
      const t = State.getTournament(g.tournamentId);
      if (t?.name) { g.tournamentName = t.name; changed = true; }
    }
    if (changed) saves.push(Storage.saveGame(g));
  });
  if (saves.length) await Promise.all(saves);
}

let _bootDone = false;
async function boot() {
  await Storage.init();

  // Handle email link sign-in before anything else
  const fs = window._fs;
  if (fs.isSignInWithEmailLink(fs.auth, window.location.href)) {
    await handleEmailLinkSignIn();
  }

  // Handle Google redirect sign-in return
  await checkGoogleRedirect();

  // Auth state fires immediately (null if signed out).
  // Load all data here so it works whether Firestore rules require auth or not.
  fs.onAuthStateChanged(fs.auth, async (user) => {
    currentUser = user;
    currentUserProfile = null;

    // loadAll uses allSettled — it never throws; individual failures are warned in console.
    await Storage.loadAll();

    // If the games collection failed to load (rules block unauthenticated reads)
    // and the user isn't signed in, show a sign-in prompt in the players tab.
    if (!user && !State.games.length && !State.players.length) {
      const c = $('#players-container');
      if (c) c.innerHTML = `<div class="empty-state">
        <h3>Sign in to view data</h3>
        <p>Your data is stored in the cloud. Sign in to access it.</p>
        <button class="btn btn-primary" onclick="showAuthModal('signin')">Sign In</button>
      </div>`;
    }

    if (user) {
      currentUserProfile = await Storage.getUser(user.uid).catch(() => null);
    }

    updateAuthUI();

    // Always re-subscribe listeners (unsubAll cancels the old ones first)
    Storage.listenAll();

    // Migration only needs to run once on first successful data load
    if (!_bootDone && State.games.length) {
      _bootDone = true;
      await migrateGames();
    } else {
      _bootDone = true;
    }

    Render.all();
  });
}

document.addEventListener('firebase-ready', boot, { once: true });

// Expose functions needed by inline HTML event handlers
Object.assign(window, {
  Modal, Render, State,
  showAuthModal, submitAuth, signOutUser, invitePlayer,
  signInWithGoogle, handleGoogleCredential, checkGoogleRedirect,
  showForgotPasswordModal, submitForgotPassword,
  toggleUserMenu, closeUserMenu,
  showChangePasswordModal, submitChangePassword, adminResetPassword,
  showPlayerModal, deletePlayer, deleteUser, showTeamModal, deleteTeam, cancelInvite, toggleAdminFeatures,
  bipChooseKind, bipChooseDetail, bipCancel,
  showDoublePlayResult, applyDoublePlay,
  showTagUpResult, applyTagUp,
  toggleCanScore, showLinkPlayerModal, submitLinkPlayer,
  showNewGameModal, openGame, selectGame, deselectGame, deleteGame, openGameForScoring, showSetupModal,
  submitPlayer, submitTeam, submitNewGame,
  startGame, setPosition, moveBatter,
  endHalfInning, endGameEarly, showSkipBatterModal, skipBatter,
  showEditScoreModal, reopenGame, _esAdj, _esSave,
  showRecapModal, _copyRecap, _shareRecap, sendRecapEmails, autoSendRecapEmails, showEmailSetupModal, _saveEmailSetup, _toggleEmailSetup,
  showNewTournamentModal, submitNewTournament, showTournamentModal, submitTournament, selectTournament, tournamentBack,
  generateTournamentGames, generateChampionshipGame, autoGenerateTournamentRound, deleteTournamentUI,
  selectPlay, clearPlaySelection,
  onFielderClick, swapFielder, swapFielderGuarded,
  switchLiveStatsTab,
  renderLiveGame, rerenderLive,
  bipStart, bipEnterLocate, bipConfirm,
  finishHit,
  // Admin mode + player view
  setPlayersView, selectPlayer, showPlayerStatsModal, showTeamStatsModal,
  setStatsMain, setTeamsView, sortTeamStats,
  showStatsFilterModal, statsFilterSearch, statsFilterDraftToggle, statsFilterSelectAll, statsFilterClearAll, applyStatsFilter, clearStatsFilter,
  setTournStatsView, setTournTeamView, sortTournPlayerStats, sortTournTeamStats,
  setHomePlayerView, setHomeTeamsView, sortHomeTeams,
  selectTeam,
  switchTab,
  sortStats, showCreateMyPlayerModal, submitMyPlayer,
  toggleSprayChart,
});
