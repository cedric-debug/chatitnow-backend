const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');

const app = express();
app.use(cors());

// Health Check
app.get("/", (req, res) => {
  res.send("ChatItNow Server is Running!");
});

const server = http.createServer(app);
const PORT = process.env.PORT || 3001;

// --- CONFIGURATION ---
const INACTIVITY_LIMIT = 10 * 60 * 1000; // 10 Minutes
const RECONNECT_GRACE_PERIOD = 3 * 60 * 1000; // 3 Minutes
const AD_DELAY_MS = 3000; // 3 Seconds mandatory wait for Ads

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
// Session Map: Key = sessionID, Value = { socketId, roomID, userData, timer }
const sessionMap = new Map(); 

// --- HELPER FUNCTIONS ---

// 1. Get the LIVE socket object from a session ID (Critical for the fix)
function getSocketFromSession(sessionID) {
  const session = sessionMap.get(sessionID);
  if (!session || !session.socketId) return null;
  return io.sockets.sockets.get(session.socketId);
}

function removeFromQueue(sessionID) {
  waitingQueue = waitingQueue.filter(u => u.sessionID !== sessionID);
}

function cleanupSession(sessionID) {
  if (!sessionMap.has(sessionID)) return;
  
  const session = sessionMap.get(sessionID);
  if (session.timer) clearTimeout(session.timer);
  
  // Notify partner
  if (session.roomID) {
    io.to(session.roomID).emit('partner_disconnected');
    // Clear room
    io.in(session.roomID).socketsLeave(session.roomID);
  }
  
  removeFromQueue(sessionID);
  sessionMap.delete(sessionID);
}

// 2. Execute Match using Session IDs (not raw sockets)
function executeMatch(sessionID1, sessionID2) {
  const socket1 = getSocketFromSession(sessionID1);
  const socket2 = getSocketFromSession(sessionID2);

  // If one of them disconnected completely during the wait, abort
  if (!socket1 || !socket2) {
    // If one is still alive, put them back in queue or let them retry
    if (socket1) {
       // Reset their match status so they can be picked up again
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

  // Update session map
  if (sessionMap.has(sessionID1)) sessionMap.get(sessionID1).roomID = roomID;
  if (sessionMap.has(sessionID2)) sessionMap.get(sessionID2).roomID = roomID;

  // Remove from queue
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
    console.log(`Rejected connection ${socket.id} (No Session ID)`);
    socket.disconnect();
    return;
  }

  socket.sessionID = sessionID;
  socket.lastActive = Date.now();

  console.log(`Connected: ${socket.id}`);

  // --- RECONNECTION HANDLER ---
  if (sessionMap.has(sessionID)) {
    const session = sessionMap.get(sessionID);
    
    // Update live socket ID in the map immediately
    session.socketId = socket.id;

    // Stop disconnect timer if active
    if (session.timer) {
      console.log(`Restored session: ${sessionID}`);
      clearTimeout(session.timer);
      session.timer = null;
    }

    // Restore data to the new socket object
    socket.userData = session.userData;
    socket.roomID = session.roomID;

    // If they were in a room, rejoin it
    if (session.roomID) {
      socket.join(session.roomID);
      socket.to(session.roomID).emit('partner_connected'); 
      socket.emit('session_restored', { status: 'connected' });
    } 
    // If they were in the queue, we don't need to do anything because
    // executeMatch() looks up the socket dynamically via getSocketFromSession()

  } else {
    // New Session
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

  // --- SEARCH LOGIC ---
  socket.on('find_partner', (userData) => {
    socket.userData = userData;
    // Update session data store
    if (sessionMap.has(socket.sessionID)) {
      sessionMap.get(socket.sessionID).userData = userData;
    }

    // Reset Queue state: remove existing entry to avoid duplicates
    removeFromQueue(socket.sessionID);

    const isGenericField = userData.field === '' || userData.field === 'Others';

    // 1. Add to Queue immediately (Store DATA, not SOCKET)
    const myEntry = { 
      sessionID: socket.sessionID, 
      userData: userData, 
      openToAny: false, 
      isMatched: false, 
      joinedAt: Date.now() 
    };
    waitingQueue.push(myEntry);

    // 2. START 3-SECOND AD TIMER
    setTimeout(() => {
      // Re-fetch entry to see if it's still valid
      const currentEntry = waitingQueue.find(u => u.sessionID === socket.sessionID);
      
      // If user left queue or already got matched, stop.
      if (!currentEntry || currentEntry.isMatched) return;

      // --- MATCHING ATTEMPT AFTER 3s ---
      const candidates = waitingQueue.filter(u => u.sessionID !== socket.sessionID && !u.isMatched);
      
      // A. Priority Match (Same Field)
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
          return;
        }
      }

      // B. If no priority match, switch to "Open" mode
      currentEntry.openToAny = true;

      // C. Find any available partner
      const anyMatch = candidates.find(u => {
        if (u.openToAny) return true; // They are desperate too
        return u.userData.field === userData.field; // I fit their priority
      });

      if (anyMatch) {
        currentEntry.isMatched = true;
        anyMatch.isMatched = true;
        executeMatch(socket.sessionID, anyMatch.sessionID);
      }

    }, AD_DELAY_MS);
  });

  socket.on('send_message', (messageData) => {
    // Robust Send: Always look up room via Session Map
    const session = sessionMap.get(socket.sessionID);
    const currentRoomID = session ? session.roomID : null;

    if (currentRoomID) {
      // Self-healing: Join room if missing
      if (!socket.rooms.has(currentRoomID)) {
        socket.join(currentRoomID);
      }
      
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

  socket.on('disconnect_partner', () => {
    cleanupSession(socket.sessionID);
  });

  socket.on('disconnect', (reason) => {
    console.log(`Disconnected: ${socket.id} (${reason})`);

    if (sessionMap.has(socket.sessionID)) {
      const session = sessionMap.get(socket.sessionID);
      
      // If waiting in queue, remove immediately
      removeFromQueue(socket.sessionID);

      if (session.roomID) {
        // If chatting, wait grace period
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