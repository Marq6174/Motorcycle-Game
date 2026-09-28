const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { WebcastPushConnection } = require('tiktok-live-connector');

const app = express();
const server = http.createServer(app);

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = 3000;
const HOST = '0.0.0.0';

app.use(express.static(path.join(__dirname, 'public')));

let currentTikTokUsername = process.env.TIKTOK_USERNAME || '';
let tiktokLiveConnection = null;

let gameState = {
  score: 0,
  goalScore: 250,
  isPaused: false,
  isManualPaused: false,
  resetTimerActive: false,
  resetTimeRemaining: 60,
  gameWon: false,
  isCrashing: false,
  crashStartTime: 0,
  crashDuration: 2200,
  tiktokUser: currentTikTokUsername,
  tiktokConnected: false
};

let resetInterval = null;
let crashTimeout = null;
let resumeTimeout = null;
let saveResumeTimeout = null;

function checkServerGoal() {
  if (gameState.score >= gameState.goalScore && !gameState.gameWon && !gameState.isCrashing && !gameState.resetTimerActive) {
    triggerWinSequence();
  }
}

function triggerWinSequence() {
  clearInterval(resetInterval);
  clearTimeout(crashTimeout);
  clearTimeout(resumeTimeout);
  clearTimeout(saveResumeTimeout);

  gameState.resetTimerActive = false;
  gameState.isCrashing = false;
  gameState.gameWon = true;
  gameState.isPaused = true;

  io.emit('gameWonSequence', {
    score: gameState.score,
    goalScore: gameState.goalScore
  });
}

function triggerCrashResetSequence() {
  clearInterval(resetInterval);
  clearTimeout(crashTimeout);
  clearTimeout(resumeTimeout);
  clearTimeout(saveResumeTimeout);

  gameState.resetTimerActive = false;
  gameState.gameWon = false;
  gameState.isCrashing = true;
  gameState.crashStartTime = Date.now();
  gameState.crashDuration = 2200;

  io.emit('startResetCrashAnimation', {
    startTime: gameState.crashStartTime,
    duration: gameState.crashDuration
  });

  crashTimeout = setTimeout(() => {
    gameState.score = 0;
    gameState.isCrashing = false;
    io.emit('scoreUpdated', { score: 0 });
    io.emit('resetCompleteNotification', { duration: 4 });

    resumeTimeout = setTimeout(() => {
      gameState.isPaused = false;
      gameState.isManualPaused = false;
      io.emit('gameResumed', { score: 0 });
    }, 4000);
  }, gameState.crashDuration);
}

// --- TIKTOK LIVE CONNECTION ---
function connectToTikTok(username) {
  if (!username) return;

  if (tiktokLiveConnection) {
    try { tiktokLiveConnection.disconnect(); } catch (e) {}
    tiktokLiveConnection = null;
  }

  currentTikTokUsername = username;
  gameState.tiktokUser = username;

  tiktokLiveConnection = new WebcastPushConnection(username, {
    processInitialData: false,
    enableExtendedGiftInfo: true
  });

  tiktokLiveConnection.connect()
    .then(state => {
      console.log(`[TikTok] Connected to @${username} (Room: ${state.roomId})`);
      gameState.tiktokConnected = true;
      io.emit('tiktokStatus', { connected: true, username: username });
    })
    .catch(err => {
      console.error(`[TikTok] Connection error: ${err.message}`);
      gameState.tiktokConnected = false;
      io.emit('tiktokStatus', { connected: false, username: username, error: err.message });
    });

  tiktokLiveConnection.on('gift', data => {
    if (data.giftType === 1 && !data.repeatEnd) return;

    const giftName = data.giftName.toLowerCase();
    const gifter = data.nickname || data.uniqueId;

    let chosenHazard = 'pothole';

    if (giftName.includes('rose') || giftName.includes('heart') || giftName.includes('finger') || 
        giftName.includes('ice') || giftName.includes('donut') || giftName.includes('panda') || 
        giftName.includes('coffee') || giftName.includes('gg')) {
      chosenHazard = 'pothole';
    } else if (giftName.includes('galaxy') || giftName.includes('lion') || giftName.includes('car') || 
             giftName.includes('plane') || giftName.includes('dragon') || giftName.includes('whale') || 
             giftName.includes('fireworks') || giftName.includes('hat') || giftName.includes('cap')) {
      chosenHazard = 'helicopter';
    } else {
      chosenHazard = Math.random() < 0.5 ? 'pothole' : 'helicopter';
    }

    io.emit('triggerViewerAction', { type: 'queueHazard', hazardType: chosenHazard, username: gifter });
  });

  tiktokLiveConnection.on('disconnected', () => {
    gameState.tiktokConnected = false;
    io.emit('tiktokStatus', { connected: false, username: username });
  });
}

if (currentTikTokUsername) {
  connectToTikTok(currentTikTokUsername);
}

// --- SOCKET.IO CLIENT ROUTING ---
io.on('connection', (socket) => {
  socket.emit('stateSync', gameState);

  socket.on('setTikTokUser', (username) => {
    connectToTikTok(username.trim());
  });

  socket.on('adjustScore', (delta) => {
    gameState.score += delta;
    io.emit('scoreUpdated', { score: gameState.score });
    checkServerGoal();
  });

  socket.on('setGoal', (newGoal) => {
    gameState.goalScore = Number(newGoal) || 250;
    gameState.gameWon = false;
    io.emit('goalUpdated', { goalScore: gameState.goalScore });
    checkServerGoal();
  });

  // Start Next Run (Resets score to 0)
  socket.on('resetAfterWin', () => {
    gameState.score = 0;
    gameState.gameWon = false;
    gameState.isPaused = false;
    io.emit('scoreUpdated', { score: 0 });
    io.emit('gameResumed', { score: 0 });
  });

  // Continue Run (Keeps current score & updates goal)
  socket.on('continueAfterWin', (newGoal) => {
    const parsed = Number(newGoal);
    if (parsed && parsed > gameState.score) {
      gameState.goalScore = parsed;
    } else {
      gameState.goalScore = gameState.score + 250;
    }
    gameState.gameWon = false;
    gameState.isPaused = false;
    io.emit('goalUpdated', { goalScore: gameState.goalScore });
    io.emit('gameResumed', { score: gameState.score });
  });

  socket.on('forceWin', () => {
    if (gameState.isCrashing || gameState.gameWon) return;
    triggerWinSequence();
  });

  socket.on('forceResetCrash', () => {
    if (gameState.isCrashing) return;
    triggerCrashResetSequence();
  });

  socket.on('spawnHazard', (data) => {
    io.emit('triggerViewerAction', {
      type: 'queueHazard',
      hazardType: data.hazardType,
      username: data.username || 'Host'
    });
  });

  socket.on('toggleManualPause', () => {
    if (gameState.resetTimerActive || gameState.isCrashing || gameState.gameWon) return;
    gameState.isManualPaused = !gameState.isManualPaused;
    gameState.isPaused = gameState.isManualPaused;
    io.emit('manualPauseToggled', { 
      isPaused: gameState.isPaused,
      isManualPaused: gameState.isManualPaused 
    });
  });

  socket.on('initiateResetCountdown', () => {
    if (gameState.resetTimerActive || gameState.isCrashing || gameState.gameWon) return;

    gameState.isPaused = true;
    gameState.resetTimerActive = true;
    gameState.resetTimeRemaining = 60;

    io.emit('resetCountdownStarted', { timeRemaining: gameState.resetTimeRemaining });

    clearInterval(resetInterval);
    resetInterval = setInterval(() => {
      gameState.resetTimeRemaining--;
      io.emit('resetCountdownTick', { timeRemaining: gameState.resetTimeRemaining });

      if (gameState.resetTimeRemaining <= 0) {
        clearInterval(resetInterval);
        triggerCrashResetSequence();
      }
    }, 1000);
  });

  socket.on('saveAndResume', () => {
    clearInterval(resetInterval);
    clearTimeout(crashTimeout);
    clearTimeout(resumeTimeout);
    clearTimeout(saveResumeTimeout);

    gameState.resetTimerActive = false;
    gameState.isCrashing = false;
    gameState.isManualPaused = false;
    gameState.gameWon = false;
    gameState.isPaused = true;

    io.emit('saveConfirmed', { score: gameState.score });

    saveResumeTimeout = setTimeout(() => {
      gameState.isPaused = false;
      io.emit('gameResumed', { score: gameState.score });
    }, 1500);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`========================================================`);
  console.log(`🔒 Game Server running at http://${HOST}:${PORT}`);
  console.log(`========================================================`);
});
