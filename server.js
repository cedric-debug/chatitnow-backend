const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');

const app = express();
app.use(cors());

// Health Check
app.get("/", (req, res) => {
  res.status(200).send("ChatItNow Server is Running!");
});

const server = http.createServer(app);
const PORT = process.env.PORT || 3001;

// --- CONFIGURATION ---
const INACTIVITY_LIMIT = 10 * 60 * 1000; // 10 Minutes
const RECONNECT_GRACE_PERIOD = 3 * 60 * 1000; // 3 Minutes

// --- TIMING CONFIG ---
const PHASE_1_DELAY = 3000; // Wait 3s for Ad/Same Field
const PHASE_2_DELAY = 2000; // Wait additional 2s for Random

const io = new Server(server, {
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  },
  pingTimeout: 60000, 
  pingInterval: 25000,
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

// --- GLOBAL STATE ---
let waitingQueue = []; 
const sessionMap = new Map(); 

// --- HELPER FUNCTIONS ---

function removeFromQueue(sessionID) {
  waitingQueue = waitingQueue.filter(u => u.sessionID !== sessionID);
}

function getSocketFromSession(sessionID) {
  const session = sessionMap.get(sessionID);
  if (!session || !session.socketId) return null;
  return io.sockets.sockets.get(session.socketId);
}

function cleanupSession(sessionID) {
  if (!sessionMap.has(sessionID)) return;
  
  const session = sessionMap.get(sessionID);
  
  if (session.timer) clearTimeout(session.timer);
  
  // Notify partner
  if (session.roomID) {
    io.to(session.roomID).emit('partner_disconnected');
    io.in(session.roomID).socketsLeave(session.roomID);
  }
  
  removeFromQueue(sessionID);
  sessionMap.delete(sessionID);
}

function executeMatch(sessionID1, sessionID2) {
  const socket1 = getSocketFromSession(sessionID1);
  const socket2 = getSocketFromSession(sessionID2);

  // If one disconnected during the wait
  if (!socket1 || !socket2) {
    if (socket1) {
       // Reset match flag so they can be picked up by someone else
       const entry = waitingQueue.find(u => u.sessionID === sessionID1);
       if (entry) entry.isMatched = false; 
    }
    if (socket2) {
       const entry = waitingQueue.find(u => u.sessionID === sessionID2);
       if (entry) entry.isMatched = false;
    }
    return;
  }

  const roomID = `${socket1.id}#${socket2.id}`;
  
  socket1.join(roomID);
  socket2.join(roomID);
  
  socket1.roomID = roomID;
  socket2.roomID = roomID;

  if (sessionMap.has(sessionID1)) sessionMap.get(sessionID1).roomID = roomID;
  if (sessionMap.has(sessionID2)) sessionMap.get(sessionID2).roomID = roomID;

  removeFromQueue(sessionID1);
  removeFromQueue(sessionID2);

  const user1Data = socket1.userData || {};
  const user2Data = socket2.userData || {};

  io.to(socket1.id).emit('matched', {
    name: user2Data.username || 'Stranger',
    field: user2Data.field || '',
    roomID: roomID
  });

  io.to(socket2.id).emit('matched', {
    name: user1Data.username || 'Stranger',
    field: user1Data.field || '',
    roomID: roomID
  });
}

// --- IDLE CHECKER ---
setInterval(() => {
  const now = Date.now();
  io.sockets.sockets.forEach((socket) => {
    if (socket.lastActive && (now - socket.lastActive > INACTIVITY_LIMIT)) {
      socket.disconnect(true);
    }
  });
}, 60 * 1000);


// --- MAIN CONNECTION LOGIC ---
io.on('connection', (socket) => {
  const sessionID = socket.handshake.auth.sessionID;
  
  if (!sessionID) {
    socket.disconnect();
    return;
  }

  socket.sessionID = sessionID;
  socket.lastActive = Date.now();

  console.log(`Connected: ${socket.id}`);

  // --- RECONNECTION HANDLER ---
  if (sessionMap.has(sessionID)) {
    const session = sessionMap.get(sessionID);
    
    session.socketId = socket.id;
    socket.userData = session.userData;
    socket.roomID = session.roomID;

    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }

    if (session.roomID) {
      socket.join(session.roomID);
      socket.to(session.roomID).emit('partner_connected'); 
      socket.emit('session_restored', { status: 'connected' });
    } else {
      const queueItem = waitingQueue.find(q => q.sessionID === sessionID);
      if (queueItem) queueItem.socket = socket;
    }

  } else {
    sessionMap.set(sessionID, { 
      socketId: socket.id, 
      roomID: null, 
      userData: null, 
      timer: null 
    });
  }

  socket.onAny(() => {
    socket.lastActive = Date.now();
  });

  // --- SEARCH LOGIC (3s Priority -> 2s Wait -> Any) ---
  socket.on('find_partner', (userData) => {
    socket.userData = userData;

    // 1. HARD RESET: Clear previous room data from session
    if (sessionMap.has(socket.sessionID)) {
      const session = sessionMap.get(socket.sessionID);
      session.userData = userData; // Update preference
      
      if (session.roomID) {
        socket.leave(session.roomID);
        session.roomID = null;
      }
    }

    // 2. Clear from queue just in case
    removeFromQueue(socket.sessionID);

    // 3. Add to Queue immediately
    const myEntry = { 
      sessionID: socket.sessionID, 
      socket: socket, 
      userData: userData, 
      openToAny: false, 
      isMatched: false, 
      joinedAt: Date.now() 
    };
    waitingQueue.push(myEntry);

    const isGenericField = userData.field === '' || userData.field === 'Others';

    // --- PHASE 1: Wait 3 Seconds (Ad View) ---
    setTimeout(() => {
      // Valid check
      const currentEntry = waitingQueue.find(u => u.sessionID === socket.sessionID);
      if (!currentEntry || currentEntry.isMatched) return;

      const candidates = waitingQueue.filter(u => u.sessionID !== socket.sessionID && !u.isMatched);
      
      // Try Priority Match (Same Field)
      if (!isGenericField) {
        const exactMatch = candidates.find(u => 
          u.userData.field === userData.field && 
          u.userData.field !== '' && 
          u.userData.field !== 'Others'
        );

        if (exactMatch) {
          currentEntry.isMatched = true;
          exactMatch.isMatched = true;
          executeMatch(socket.sessionID, exactMatch.sessionID);
          return; // Match found, stop here.
        }
      }

      // --- PHASE 2: Wait Additional 2 Seconds ---
      setTimeout(() => {
        // Valid check again
        const reCheckEntry = waitingQueue.find(u => u.sessionID === socket.sessionID);
        if (!reCheckEntry || reCheckEntry.isMatched) return;

        // Switch to "Open" mode
        reCheckEntry.openToAny = true;

        // Try Any Match
        // We match if:
        // 1. They are also Open (Desperate)
        // 2. OR I match THEIR priority field (I am their perfect match)
        const openCandidates = waitingQueue.filter(u => u.sessionID !== socket.sessionID && !u.isMatched);
        
        const anyMatch = openCandidates.find(u => {
          if (u.openToAny) return true; // They match anyone
          return u.userData.field === userData.field; // I match them
        });

        if (anyMatch) {
          reCheckEntry.isMatched = true;
          anyMatch.isMatched = true;
          executeMatch(socket.sessionID, anyMatch.sessionID);
        }

      }, PHASE_2_DELAY); // +2 Seconds

    }, PHASE_1_DELAY); // 3 Seconds
  });

  socket.on('send_message', (messageData) => {
    const session = sessionMap.get(socket.sessionID);
    const currentRoomID = session ? session.roomID : null;

    if (currentRoomID) {
      if (!socket.rooms.has(currentRoomID)) socket.join(currentRoomID);
      
      socket.to(currentRoomID).emit('receive_message', {
        text: messageData.text,
        type: 'stranger',
        replyTo: messageData.replyTo,
        timestamp: messageData.timestamp
      });
    }
  });

  socket.on('typing', (isTyping) => {
    const session = sessionMap.get(socket.sessionID);
    const currentRoomID = session ? session.roomID : null;
    if (currentRoomID) {
      socket.to(currentRoomID).emit('partner_typing', isTyping);
    }
  });

  // --- MANUAL DISCONNECT ---
  socket.on('disconnect_partner', () => {
    const session = sessionMap.get(socket.sessionID);
    if (session && session.roomID) {
      // Notify ONLY the partner that I left
      socket.to(session.roomID).emit('partner_disconnected');
      
      // Clear the room logic
      io.in(session.roomID).socketsLeave(session.roomID);
      session.roomID = null;
    }
    removeFromQueue(socket.sessionID);
  });

  socket.on('disconnect', (reason) => {
    console.log(`Disconnected: ${socket.id}`);

    if (sessionMap.has(socket.sessionID)) {
      const session = sessionMap.get(socket.sessionID);
      
      removeFromQueue(socket.sessionID);

      if (session.roomID) {
        socket.to(session.roomID).emit('partner_reconnecting_server');
        
        session.timer = setTimeout(() => {
          console.log(`Session expired: ${socket.sessionID}`);
          cleanupSession(socket.sessionID);
        }, RECONNECT_GRACE_PERIOD);
      } else {
        sessionMap.delete(socket.sessionID);
      }
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SERVER RUNNING ON PORT ${PORT}`);
});