/* =====================================================
   WIFFLEBALL TRACKER
   ===================================================== */

/* ----------- Helpers ----------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const uid = () => 'id_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Save/restore scrollTop for all independent scroll containers so background
// Firestore re-renders don't jump the user's scroll position.
function _withScrollPreserved(fn) {
  const selectors = [
    ['main',                  () => document.querySelector('main')],
    ['games-list',            () => document.getElementById('games-list')],
    ['games-detail',          () => document.getElementById('games-detail')],
    ['tournaments-list',      () => document.getElementById('tournaments-list')],
    ['tournaments-detail',    () => document.getElementById('tournaments-detail')],
    ['admin-players-container', () => document.getElementById('admin-players-container')],
    ['admin-games-container', () => document.getElementById('admin-games-container')],
  ];
  const saved = selectors.map(([, getter]) => {
    const el = getter(); return el ? el.scrollTop : 0;
  });
  fn();
  selectors.forEach(([, getter], i) => {
    const el = getter(); if (el) el.scrollTop = saved[i];
  });
}

function toast(msg, type = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'toast'; }, 2400);
}

/* ============================================================
   STORAGE LAYER (Firestore)
   ============================================================ */
const Storage = {
  async init() {}, // Firebase already initialised by module script

  _unsubs: [], // active onSnapshot unsubscribers

  async loadAll() {
    const fs = window._fs;
    // allSettled so a permission-denied on one collection (e.g. 'users' for
    // unauthenticated visitors) doesn't prevent the rest from loading.
    const [ps, ts, gs, us, tr] = await Promise.allSettled([
      fs.getDocs(fs.collection(fs.db, 'players')),
      fs.getDocs(fs.collection(fs.db, 'teams')),
      fs.getDocs(fs.collection(fs.db, 'games')),
      fs.getDocs(fs.collection(fs.db, 'users')),
      fs.getDocs(fs.collection(fs.db, 'tournaments')),
    ]);
    if (ps.status === 'fulfilled') State.players     = ps.value.docs.map(d => d.data());
    if (ts.status === 'fulfilled') State.teams       = ts.value.docs.map(d => d.data());
    if (gs.status === 'fulfilled') State.games       = gs.value.docs.map(d => d.data());
    if (us.status === 'fulfilled') State.users       = us.value.docs.map(d => d.data());
    if (tr.status === 'fulfilled') State.tournaments = tr.value.docs.map(d => d.data());
    // Surface load errors for debugging but don't throw — partial data is usable
    [ps, ts, gs, us, tr].forEach((r, i) => {
      if (r.status === 'rejected')
        console.warn('loadAll collection', i, 'failed:', r.reason?.code, r.reason?.message);
    });
  },

  unsubAll() {
    this._unsubs.forEach(u => u());
    this._unsubs = [];
  },

  listenAll() {
    this.unsubAll(); // cancel any existing listeners before re-subscribing
    const fs = window._fs;
    this._unsubs.push(
      fs.onSnapshot(fs.collection(fs.db, 'players'), snap => {
        State.players = snap.docs.map(d => d.data());
        _withScrollPreserved(() => {
          Render.players();
          Render.adminPlayers();
          Render.home();
        });
      }, err => console.warn('players listener:', err.message)),

      fs.onSnapshot(fs.collection(fs.db, 'teams'), snap => {
        State.teams = snap.docs.map(d => d.data());
        _withScrollPreserved(() => {
          Render.teams();
          Render.adminTeams();
          Render.home();
        });
      }, err => console.warn('teams listener:', err.message)),

      fs.onSnapshot(fs.collection(fs.db, 'games'), snap => {
        snap.docChanges().forEach(change => {
          const g = change.doc.data();
          if (change.type === 'removed') {
            State.games = State.games.filter(x => x.id !== g.id);
          } else {
            const idx = State.games.findIndex(x => x.id === g.id);
            if (idx >= 0) State.games[idx] = g; else State.games.push(g);
          }
        });
        // Preserve scroll across all background re-renders triggered by game changes.
        // Also refresh player/team stats since they're computed from game events.
        _withScrollPreserved(() => {
          Render.games();
          Render.home();
          Render.players();
          Render.teams();
          Render.tournaments && Render.tournaments();
          Render.adminGames && Render.adminGames();
        });
        if (LiveGameId) rerenderLive();
      }, err => console.warn('games listener:', err.message)),

      fs.onSnapshot(fs.collection(fs.db, 'tournaments'), snap => {
        State.tournaments = snap.docs.map(d => d.data());
        _withScrollPreserved(() => {
          Render.tournaments && Render.tournaments();
          Render.adminEvents && Render.adminEvents();
        });
      }, err => console.warn('tournaments listener:', err.message)),

      fs.onSnapshot(fs.collection(fs.db, 'users'), snap => {
        State.users = snap.docs.map(d => d.data());
        if (isAdminUser()) Render.users && Render.users();
        // Refresh currentUserProfile in case canScore or playerId was changed
        if (currentUser) {
          currentUserProfile = State.getUser(currentUser.uid) || currentUserProfile;
          Render.home();
        }
        // Clean up any players linked to users that no longer exist
        const uids = new Set(State.users.map(u => u.uid));
        State.players.filter(p => p.userId && !uids.has(p.userId)).forEach(p => {
          p.userId = null;
          p.invitePending = false;
          Storage.savePlayer(p);
        });
      }, err => console.warn('users listener:', err.message))
    );
  },

  async saveUser(profile) {
    const fs = window._fs;
    await fs.setDoc(fs.doc(fs.db, 'users', profile.uid), profile);
  },
  async removeUser(uid) {
    const fs = window._fs;
    await fs.deleteDoc(fs.doc(fs.db, 'users', uid));
  },
  async getUser(uid) {
    const fs = window._fs;
    const snap = await fs.getDocs(fs.collection(fs.db, 'users'));
    const d = snap.docs.find(x => x.id === uid);
    return d ? d.data() : null;
  },
  async saveAll() { /* no-op — individual saves handle this */ },

  async savePlayer(p) {
    const fs = window._fs;
    await fs.setDoc(fs.doc(fs.db, 'players', p.id), p);
  },
  async removePlayer(id) {
    const fs = window._fs;
    await fs.deleteDoc(fs.doc(fs.db, 'players', id));
  },
  async saveTeam(t) {
    const fs = window._fs;
    await fs.setDoc(fs.doc(fs.db, 'teams', t.id), t);
  },
  async removeTeam(id) {
    const fs = window._fs;
    await fs.deleteDoc(fs.doc(fs.db, 'teams', id));
  },
  async saveGame(g) {
    const fs = window._fs;
    await fs.setDoc(fs.doc(fs.db, 'games', g.id), g);
  },
  async removeGame(id) {
    const fs = window._fs;
    await fs.deleteDoc(fs.doc(fs.db, 'games', id));
  },
  async saveTournament(t) {
    const fs = window._fs;
    await fs.setDoc(fs.doc(fs.db, 'tournaments', t.id), t);
  },
  async removeTournament(id) {
    const fs = window._fs;
    await fs.deleteDoc(fs.doc(fs.db, 'tournaments', id));
  },

  async exportJson() {
    const blob = new Blob([JSON.stringify({ ...State.snapshot(), tournaments: State.tournaments }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'wiffleball-data-' + new Date().toISOString().slice(0,10) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  },

  async importJson(file) {
    const text = await file.text();
    const data = JSON.parse(text);
    await Promise.all([
      ...(data.players     || []).map(p => Storage.savePlayer(p)),
      ...(data.teams       || []).map(t => Storage.saveTeam(t)),
      ...(data.games       || []).map(g => Storage.saveGame(g)),
      ...(data.tournaments || []).map(t => Storage.saveTournament(t)),
    ]);
    toast('Imported successfully', 'success');
  },
};

/* ============================================================
   STATE
   ============================================================ */
const State = {
  players: [],
  teams: [],
  games: [],
  users: [],
  tournaments: [],

  snapshot() { return { players: this.players, teams: this.teams, games: this.games }; },
  getUser(uid)         { return this.users.find(u => u.uid === uid) || null; },
  getPlayer(id)        { return this.players.find(p => p.id === id); },
  getTeam(id)          { return this.teams.find(t => t.id === id); },
  getGame(id)          { return this.games.find(g => g.id === id); },
  getTournament(id)    { return this.tournaments.find(t => t.id === id); },

  // ---- Tournament CRUD ----
  async addTournament(data) {
    const t = { id: uid(), name: data.name.trim(), teamIds: [...(data.teamIds||[])], format: data.format || 'round_robin', createdAt: Date.now(), status: 'active' };
    this.tournaments.push(t);
    await Storage.saveTournament(t);
    return t;
  },
  async updateTournament(id, patch) {
    const t = this.getTournament(id); if (!t) return;
    Object.assign(t, patch);
    await Storage.saveTournament(t);
  },
  async deleteTournament(id) {
    this.tournaments = this.tournaments.filter(t => t.id !== id);
    await Storage.removeTournament(id);
  },

  computeTournamentStandings(tournamentId) {
    const tourn = this.getTournament(tournamentId); if (!tourn) return [];
    // Only count round-robin games (exclude championship)
    const games = this.games.filter(g => g.tournamentId === tournamentId && g.status === 'completed' && !g.isChampionship);
    return tourn.teamIds.map(teamId => {
      const team = this.getTeam(teamId); if (!team) return null;
      let W=0, L=0, T=0, RF=0, RA=0;
      games.forEach(g => {
        if (g.homeTeamId !== teamId && g.awayTeamId !== teamId) return;
        const isHome = g.homeTeamId === teamId;
        const my = isHome ? g.score.home : g.score.away;
        const opp = isHome ? g.score.away : g.score.home;
        RF += my; RA += opp;
        if (my > opp) W++; else if (my < opp) L++; else T++;
      });
      return { team, W, L, T, RF, RA, pts: W*2+T, rd: RF-RA };
    }).filter(Boolean).sort((a, b) => b.pts - a.pts || a.RA - b.RA || b.rd - a.rd);
  },

  computeDoubleElimStandings(tournamentId) {
    const tourn = this.getTournament(tournamentId); if (!tourn) return [];
    const games = this.games.filter(g => g.tournamentId === tournamentId && !g.isChampionship);
    const completedGames = games.filter(g => g.status === 'completed');
    return tourn.teamIds.map(teamId => {
      const team = this.getTeam(teamId); if (!team) return null;
      let W=0, L=0, RF=0, RA=0;
      completedGames.forEach(g => {
        if (g.homeTeamId !== teamId && g.awayTeamId !== teamId) return;
        const isHome = g.homeTeamId === teamId;
        const my = isHome ? g.score.home : g.score.away;
        const opp = isHome ? g.score.away : g.score.home;
        RF += my; RA += opp;
        if (my > opp) W++; else if (my < opp) L++;
      });
      const gamesPlayed = W + L;
      const eliminated = L >= 2;
      return { team, W, L, RF, RA, gamesPlayed, eliminated };
    }).filter(Boolean).sort((a, b) => {
      if (a.eliminated !== b.eliminated) return a.eliminated ? 1 : -1;
      return b.W - a.W || a.L - b.L;
    });
  },

  // ---- User CRUD ----
  async deleteUser(uid) {
    this.users = this.users.filter(u => u.uid !== uid);
    await Storage.removeUser(uid);
  },

  // ---- Player CRUD ----
  async addPlayer(data) {
    const p = { id: uid(), name: data.name.trim(), jerseyNumber: (data.jerseyNumber || '').trim(), createdAt: Date.now() };
    this.players.push(p);
    await Storage.savePlayer(p);
    return p;
  },
  async updatePlayer(id, data) {
    const p = this.getPlayer(id); if (!p) return;
    p.name = data.name.trim();
    p.jerseyNumber = (data.jerseyNumber || '').trim();
    await Storage.savePlayer(p);
  },
  async deletePlayer(id) {
    const teamsToUpdate = this.teams.filter(t => t.playerIds.includes(id));
    this.players = this.players.filter(p => p.id !== id);
    this.teams.forEach(t => { t.playerIds = t.playerIds.filter(pid => pid !== id); });
    await Storage.removePlayer(id);
    await Promise.all(teamsToUpdate.map(t => Storage.saveTeam(t)));
    // Remove games where a participating team now has fewer than 2 players
    const thinTeams = new Set(this.teams.filter(t => t.playerIds.length < 2).map(t => t.id));
    if (thinTeams.size) {
      const broken = this.games.filter(g => thinTeams.has(g.homeTeamId) || thinTeams.has(g.awayTeamId));
      this.games = this.games.filter(g => !thinTeams.has(g.homeTeamId) && !thinTeams.has(g.awayTeamId));
      await Promise.all(broken.map(g => Storage.removeGame(g.id)));
    }
  },

  // ---- Team CRUD ----
  async addTeam(data) {
    const t = { id: uid(), name: data.name.trim(), playerIds: [...(data.playerIds || [])], color: data.color || null, createdAt: Date.now() };
    this.teams.push(t);
    await Storage.saveTeam(t);
    return t;
  },
  async updateTeam(id, data) {
    const t = this.getTeam(id); if (!t) return;
    t.name = data.name.trim();
    t.playerIds = [...(data.playerIds || [])];
    if (data.color !== undefined) t.color = data.color;
    await Storage.saveTeam(t);
  },
  async deleteTeam(id) {
    const broken = this.games.filter(g => g.homeTeamId === id || g.awayTeamId === id);
    this.games = this.games.filter(g => g.homeTeamId !== id && g.awayTeamId !== id);
    this.teams = this.teams.filter(t => t.id !== id);
    await Storage.removeTeam(id);
    await Promise.all(broken.map(g => Storage.removeGame(g.id)));
  },

  // ---- Game CRUD ----
  async addGame(data) {
    const home = this.getTeam(data.homeTeamId);
    const away = this.getTeam(data.awayTeamId);
    if (!home || !away) throw new Error('Both teams required');
    if (!data.allowSharedPlayers) {
      const shared = (home.playerIds || []).filter(id => (away.playerIds || []).includes(id));
      if (shared.length) {
        const names = shared.map(id => this.getPlayer(id)?.name || id).join(', ');
        throw new Error(`Player(s) on both teams: ${names}`);
      }
    }

    const defaultPositions = (team) => {
      const positions = {};
      const ids = team.playerIds;
      if (ids.length === 2) {
        positions[ids[0]] = 'P';
        positions[ids[1]] = 'CF';
      } else if (ids.length >= 3) {
        positions[ids[0]] = 'P';
        positions[ids[1]] = 'CF';
        for (let i = 2; i < ids.length; i++) positions[ids[i]] = 'EH';
      }
      return positions;
    };

    const g = {
      id: uid(),
      createdAt: Date.now(),
      status: 'setup',
      homeTeamId: home.id,
      awayTeamId: away.id,
      homeBattingOrder: [...home.playerIds],
      awayBattingOrder: [...away.playerIds],
      homePositions: defaultPositions(home),
      awayPositions: defaultPositions(away),

      // Live tracking state
      numInnings: data.numInnings || 7,
      currentInning: 1,
      currentHalf: 'top',  // 'top' = away batting, 'bottom' = home batting
      score: { home: 0, away: 0 },
      lineScore: [],       // [{ inning, top: runs, bottom: runs }]
      outs: 0,
      balls: 0,
      strikes: 0,
      fouls: 0,
      bases: { 1: null, 2: null, 3: null }, // runner objects
      runnerCounter: 0,
      homeBatterIdx: 0,
      awayBatterIdx: 0,
      events: [],

      isOver: false,
      ...(data.tournamentId   ? { tournamentId: data.tournamentId,
                                  tournamentName: this.getTournament(data.tournamentId)?.name || null } : {}),
      ...(data.isChampionship ? { isChampionship: true }               : {}),
      ...(data.deRound        ? { deRound: data.deRound }              : {}),
    };
    this.games.push(g);
    await Storage.saveGame(g);
    return g;
  },
  async updateGame(id, patch) {
    const g = this.getGame(id);
    if (!g) return;
    Object.assign(g, patch);
    await Storage.saveGame(g);
  },
  async deleteGame(id) {
    this.games = this.games.filter(g => g.id !== id);
    await Storage.removeGame(id);
  },

  // ---- Stat aggregation from event log ----
  // gameIds: optional Set<string> — if provided, only games in the set are counted
  computePlayerStats(playerId, gameIds = null) {
    let AB=0, H=0, R=0, RBI=0, BB=0, TB=0, K_bat=0;
    let K_looking=0, K_swinging=0, K_foul=0;
    let pK=0, pBB=0, pIP_outs=0, pER=0, pR=0, pKL=0, pKS=0, pKF=0, pH=0;
    let pBF=0, pPitches=0, pStrikePitches=0;
    let E=0, PO=0, dpAttempts=0, dpSuccesses=0, tagAttempts=0, tagSuccesses=0; // fielding
    let singles=0, doubles=0, triples=0, hrs=0;
    const pitchedGames = new Set();
    const battedGames  = new Set();
    const fieldedGames = new Set();

    const games = gameIds ? this.games.filter(g => gameIds.has(g.id)) : this.games;
    games.forEach(g => {
      (g.events || []).forEach(e => {
        if (e.type !== 'pa_end') return; // only summarize at end of plate appearance
        const isBat = e.batterId === playerId;
        const isPit = e.pitcherId === playerId;

        if (isBat) {
          if (e.outcome === 'BB') BB++;
          else if (e.outcome === '1B') { AB++; H++; singles++; TB += 1; }
          else if (e.outcome === '2B') { AB++; H++; doubles++; TB += 2; }
          else if (e.outcome === '3B') { AB++; H++; triples++; TB += 3; }
          else if (e.outcome === 'HR') { AB++; H++; hrs++; TB += 4; }
          else if (e.outcome === 'K')  {
            AB++; K_bat++;
            if (e.kType === 'looking')  K_looking++;
            else if (e.kType === 'swinging') K_swinging++;
            else if (e.kType === 'foul_out') K_foul++;
          }
          else if (e.outcome === 'OUT') { AB++; }
          else if (e.outcome === 'ERR_REACH') { AB++; } // reached on error: AB but no hit
          RBI += e.rbi || 0;
          battedGames.add(g.id);
        }
        if (isPit) {
          if (e.outcome === 'BB') pBB++;
          if (e.outcome === 'K') {
            pK++;
            if (e.kType === 'looking')  pKL++;
            else if (e.kType === 'swinging') pKS++;
            else if (e.kType === 'foul_out') pKF++;
          }
          if (['1B','2B','3B','HR'].includes(e.outcome)) pH++;
          // Innings pitched: count outs recorded by this pitcher (K, OUT)
          if (e.outcome === 'K' || e.outcome === 'OUT') pIP_outs++;
          pER += e.earnedRuns || 0;
          pR  += e.earnedRuns || 0; // earnedRuns includes batter's run on HR; runsScoredBy misses it
          pBF++;
          pPitches      += e.pitches       || 0;
          pStrikePitches += e.strikePitches || 0;
          pitchedGames.add(g.id);
        }
        if (e.errorById === playerId) { E++; fieldedGames.add(g.id); }
        if (e.fielderId === playerId && e.outcome === 'OUT') { PO++; fieldedGames.add(g.id); }
        if (e.fielderId === playerId && (e.doublePlay || e.dpAttempted)) { dpAttempts++; if (e.doublePlay) dpSuccesses++; fieldedGames.add(g.id); }
        if (e.fielderId === playerId && e.sacFly) { tagAttempts++; if (e.sacFlyOut) tagSuccesses++; fieldedGames.add(g.id); }
        if (e.runsScoredBy && e.runsScoredBy.includes(playerId)) R++;
      });
    });

    const PA = AB + BB;
    const AVG = AB ? H / AB : 0;
    const OBP = PA ? (H + BB) / PA : 0;
    const SLG = AB ? TB / AB : 0;
    const OPS = OBP + SLG;
    const IP    = pIP_outs / 3;
    const ERA   = IP > 0 ? (pER * 9) / IP : null;
    const pWHIP = IP > 0 ? (pBB + pH) / IP : null;
    const pGP   = pitchedGames.size;
    const pPerIP  = IP > 0      ? pPitches / IP       : null;
    const pPerBF  = pBF > 0     ? pPitches / pBF      : null;
    const pSPct   = pPitches > 0 ? pStrikePitches / pPitches : null;
    const pKPerBF  = pBF > 0    ? pK / pBF            : null;
    const pKPerInn = IP > 0     ? pK / IP             : null;
    const pBBPerInn = IP > 0    ? pBB / IP            : null;
    const GP  = battedGames.size;
    // Fielding GP = same as batting GP — everyone who bats also fields in wiffleball
    const fGP = battedGames.size;
    const dpPct  = dpAttempts  > 0 ? dpSuccesses  / dpAttempts  : null;
    const tagPct = tagAttempts > 0 ? tagSuccesses / tagAttempts : null;

    return {
      GP, AB, H, R, RBI, BB, K_bat, K_looking, K_swinging, K_foul, AVG, OBP, SLG, OPS, PA, TB,
      singles, doubles, triples, hrs,
      pK, pKL, pKS, pKF, pBB, pER, pR, pH, IP, ERA, pWHIP,
      pBF, pPitches, pStrikePitches, pPerIP, pPerBF, pSPct, pKPerBF, pKPerInn, pBBPerInn,
      E, PO, pGP, fGP,
      dpAttempts, dpSuccesses, dpPct, tagAttempts, tagSuccesses, tagPct,
    };
  },

  computeTeamStats(teamId, gameIds = null) {
    const pool  = gameIds ? this.games.filter(g => gameIds.has(g.id)) : this.games;
    const games = pool.filter(g => g.homeTeamId === teamId || g.awayTeamId === teamId);
    const completed = games.filter(g => g.status === 'completed');
    let wins = 0, losses = 0, ties = 0, runsFor = 0, runsAgainst = 0;
    completed.forEach(g => {
      const isHome = g.homeTeamId === teamId;
      const my = isHome ? g.score.home : g.score.away;
      const opp = isHome ? g.score.away : g.score.home;
      runsFor += my; runsAgainst += opp;
      if (my > opp) wins++;
      else if (my < opp) losses++;
      else ties++;
    });
    return {
      gamesPlayed: completed.length,
      gamesScheduled: games.length - completed.length,
      wins, losses, ties, runsFor, runsAgainst,
    };
  },

  computeTeamBattingStats(teamId, gameIds = null) {
    let AB=0, H=0, R=0, RBI=0, BB=0, TB=0, K=0, singles=0, doubles=0, triples=0, hrs=0;
    const pool = gameIds ? this.games.filter(g => gameIds.has(g.id)) : this.games;
    pool.forEach(g => {
      if (g.homeTeamId !== teamId && g.awayTeamId !== teamId) return;
      const battingHalf = g.homeTeamId === teamId ? 'bottom' : 'top';
      (g.events || []).forEach(e => {
        if (e.type !== 'pa_end' || e.half !== battingHalf) return;
        if (e.outcome === 'BB') BB++;
        else if (e.outcome === '1B') { AB++; H++; singles++; TB += 1; }
        else if (e.outcome === '2B') { AB++; H++; doubles++; TB += 2; }
        else if (e.outcome === '3B') { AB++; H++; triples++; TB += 3; }
        else if (e.outcome === 'HR') { AB++; H++; hrs++; TB += 4; }
        else if (e.outcome === 'K')  { AB++; K++; }
        else if (e.outcome === 'OUT' || e.outcome === 'ERR_REACH') AB++;
        RBI += e.rbi || 0;
        R += (e.runsScoredBy || []).length;
      });
    });
    const PA = AB + BB;
    return {
      PA, AB, H, R, RBI, BB, K, TB, singles, doubles, triples, hrs,
      AVG: AB ? H / AB : 0,
      OBP: PA ? (H + BB) / PA : 0,
      SLG: AB ? TB / AB : 0,
    };
  },

  computeTeamPitchingStats(teamId, gameIds = null) {
    let outs=0, ER=0, R=0, K=0, BB=0, H=0, BF=0, pitches=0, strikePitches=0;
    const pool = gameIds ? this.games.filter(g => gameIds.has(g.id)) : this.games;
    pool.forEach(g => {
      if (g.homeTeamId !== teamId && g.awayTeamId !== teamId) return;
      const pitchingHalf = g.homeTeamId === teamId ? 'top' : 'bottom';
      (g.events || []).forEach(e => {
        if (e.type !== 'pa_end' || e.half !== pitchingHalf) return;
        if (e.outcome === 'K')  { K++; outs++; }
        else if (e.outcome === 'OUT') outs++;
        else if (e.outcome === 'BB') BB++;
        else if (['1B','2B','3B','HR'].includes(e.outcome)) H++;
        ER += e.earnedRuns || 0;
        R  += (e.runsScoredBy || []).length;
        BF++;
        pitches       += e.pitches       || 0;
        strikePitches += e.strikePitches || 0;
      });
    });
    const IP     = outs / 3;
    const ERA    = IP > 0        ? (ER * 9) / IP       : null;
    const WHIP   = IP > 0        ? (BB + H) / IP       : null;
    const pPerIP  = IP > 0       ? pitches / IP         : null;
    const pPerBF  = BF > 0       ? pitches / BF         : null;
    const sPct    = pitches > 0  ? strikePitches / pitches : null;
    const kPerBF  = BF > 0       ? K / BF               : null;
    const kPerInn = IP > 0       ? K / IP               : null;
    const bbPerInn = IP > 0      ? BB / IP              : null;
    return { IP, ER, R, K, BB, H, ERA, WHIP, pitches, pPerIP, pPerBF, sPct, kPerBF, kPerInn, bbPerInn };
  },

  computeTeamFieldingStats(teamId, gameIds = null) {
    let E = 0, PO = 0, dpAttempts = 0, dpSuccesses = 0, tagAttempts = 0, tagSuccesses = 0;
    const pool  = gameIds ? this.games.filter(g => gameIds.has(g.id)) : this.games;
    const games = pool.filter(g => g.homeTeamId === teamId || g.awayTeamId === teamId);
    const GP = games.filter(g => g.status === 'completed').length;
    games.forEach(g => {
      // The team fields during the opposite half from when they bat
      const fieldingHalf = g.homeTeamId === teamId ? 'top' : 'bottom';
      (g.events || []).forEach(e => {
        if (e.type !== 'pa_end' || e.half !== fieldingHalf) return;
        if (e.errorById) E++;
        if (e.outcome === 'OUT' || e.outcome === 'K') PO++;
        if (e.doublePlay || e.dpAttempted) { dpAttempts++; if (e.doublePlay) dpSuccesses++; }
        if (e.sacFly) { tagAttempts++; if (e.sacFlyOut) tagSuccesses++; }
      });
    });
    const dpPct  = dpAttempts  > 0 ? dpSuccesses  / dpAttempts  : null;
    const tagPct = tagAttempts > 0 ? tagSuccesses / tagAttempts : null;
    return { GP, E, PO, dpAttempts, dpSuccesses, dpPct, tagAttempts, tagSuccesses, tagPct };
  },

  // Hit locations across all games for a player
  getPlayerHitLocations(playerId) {
    const locs = [];
    this.games.forEach(g => {
      (g.events || []).forEach(e => {
        if (e.type === 'pa_end' && e.batterId === playerId && e.location) {
          locs.push({ ...e.location, outcome: e.outcome });
        }
      });
    });
    return locs;
  }
};

/* ============================================================
   GAME LOGIC: base running, pitch handling
   ============================================================ */

// targetBase: 1, 2, 3, or 4 (home / scored)
// Returns { newBases, runnerIdsScored }
function advanceRunners(bases, targetBase, batterRunner) {
  const newBases = { 1: bases[1], 2: bases[2], 3: bases[3] };
  const runnerIdsScored = [];

  // Home run: everyone scores, batter scores
  if (targetBase === 4) {
    for (let b = 3; b >= 1; b--) {
      if (newBases[b]) { runnerIdsScored.push(newBases[b].id); newBases[b] = null; }
    }
    runnerIdsScored.push(batterRunner.id);
    return { newBases, runnerIdsScored };
  }

  // Place batter on target base, cascade if occupied
  let toForce = newBases[targetBase];
  newBases[targetBase] = batterRunner;
  let nextBase = targetBase + 1;
  while (toForce) {
    if (nextBase > 3) {
      runnerIdsScored.push(toForce.id);
      toForce = null;
    } else {
      const next = newBases[nextBase];
      newBases[nextBase] = toForce;
      toForce = next;
      nextBase++;
    }
  }
  return { newBases, runnerIdsScored };
}

// Walk: batter to 1B with force-only chain
function walkAdvance(bases, batterRunner) {
  return advanceRunners(bases, 1, batterRunner);
}

// Hit: all runners advance the same number of bases as the batter
function hitAdvance(bases, advanceBases, batterRunner) {
  const newBases = { 1: null, 2: null, 3: null };
  const runnerIdsScored = [];

  if (advanceBases >= 4) {
    for (let b = 3; b >= 1; b--) {
      if (bases[b]) runnerIdsScored.push(bases[b].id);
    }
    runnerIdsScored.push(batterRunner.id);
    return { newBases, runnerIdsScored };
  }

  for (let b = 3; b >= 1; b--) {
    if (!bases[b]) continue;
    const dest = b + advanceBases;
    if (dest > 3) {
      runnerIdsScored.push(bases[b].id);
    } else {
      newBases[dest] = bases[b];
    }
  }
  newBases[advanceBases] = batterRunner;
  return { newBases, runnerIdsScored };
}

const battingTeamId = (g) => g.currentHalf === 'top' ? g.awayTeamId : g.homeTeamId;
const fieldingTeamId = (g) => g.currentHalf === 'top' ? g.homeTeamId : g.awayTeamId;
const battingOrderArr = (g) => g.currentHalf === 'top' ? g.awayBattingOrder : g.homeBattingOrder;
const fieldingPositions = (g) => g.currentHalf === 'top' ? g.homePositions : g.awayPositions;
const battingIdxKey = (g) => g.currentHalf === 'top' ? 'awayBatterIdx' : 'homeBatterIdx';

function currentBatterId(g) {
  const order = battingOrderArr(g);
  const idx = g[battingIdxKey(g)] % order.length;
  return order[idx];
}
function nextBatterId(g) {
  const order = battingOrderArr(g);
  const idx = (g[battingIdxKey(g)] + 1) % order.length;
  return order[idx];
}
function currentPitcherId(g) {
  const positions = fieldingPositions(g);
  return Object.keys(positions).find(pid => positions[pid] === 'P');
}
function currentCFId(g) {
  const positions = fieldingPositions(g);
  return Object.keys(positions).find(pid => positions[pid] === 'CF');
}

function makeRunner(g, playerId) {
  g.runnerCounter = (g.runnerCounter || 0) + 1;
  const player = State.getPlayer(playerId);
  return {
    id: uid(),
    playerId,
    name: player ? player.name.split(' ')[0] : '?',
    number: g.runnerCounter,
  };
}
