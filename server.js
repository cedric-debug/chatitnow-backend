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

// --- CONFIGURATION UPDATED ---
// 1. INACTIVITY_LIMIT: How long can they stay silent before we kick them? 
// SET TO: 24 Hours ( effectively "never" unless they stay open for a day)
const INACTIVITY_LIMIT = 24 * 60 * 60 * 1000; 

// 2. RECONNECT_GRACE_PERIOD: How long do we wait if they close the app/tab?
// SET TO: 24 Hours (Session stays alive waiting for them to reopen the app)
const RECONNECT_GRACE_PERIOD = 24 * 60 * 60 * 1000; 

// 3. AD DELAY: 3 Seconds mandatory wait
const AD_DELAY_MS = 3000; 

// 4. PRIORITY WAIT: 2 Seconds additional wait
const PHASE_2_DELAY = 2000;

const io = new Server(server, {
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  },
  // Keep ping settings standard to detect network drops quickly
  // so we can switch them to "Reconnecting" status on the partner's screen
  pingTimeout: 60000, 
  pingInterval: 25000,
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

// --- GLOBAL STATE ---
let waitingQueue = []; 
// Session Map: Key = sessionID, Value = { socketId, roomID, userData, timer, partnerSessionID, messageQueue }
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

  // Link partners and clear queues
  if (sessionMap.has(sessionID1)) {
    const s1 = sessionMap.get(sessionID1);
    s1.roomID = roomID;
    s1.partnerSessionID = sessionID2;
    s1.messageQueue = [];
  }
  if (sessionMap.has(sessionID2)) {
    const s2 = sessionMap.get(sessionID2);
    s2.roomID = roomID;
    s2.partnerSessionID = sessionID1;
    s2.messageQueue = [];
  }

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

// --- IDLE CHECKER (Modified to be lenient) ---
setInterval(() => {
  const now = Date.now();
  io.sockets.sockets.forEach((socket) => {
    // Only disconnect if they are connected AND exceeded the 24 hour limit
    if (socket.connected && socket.lastActive && (now - socket.lastActive > INACTIVITY_LIMIT)) {
      console.log(`Force disconnecting idle socket: ${socket.id}`);
      socket.disconnect(true);
    }
  });
}, 60 * 1000); // Check every minute


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

  // --- RECONNECTION HANDLER (Stale Check + Session Restore) ---
  if (sessionMap.has(sessionID)) {
    const session = sessionMap.get(sessionID);
    
    // Update live socket ID
    session.socketId = socket.id;
    socket.userData = session.userData;
    socket.roomID = session.roomID;

    // [FEATURE: Stale Connection Check]
    // Cancel the "Death Timer" because they came back
    if (session.timer) {
      console.log(`Restored session: ${sessionID} (Timer cancelled)`);
      clearTimeout(session.timer);
      session.timer = null;
    }

    if (session.roomID) {
      socket.join(session.roomID);
      socket.to(session.roomID).emit('partner_connected'); 
      socket.emit('session_restored', { status: 'connected' });

      // [FEATURE: Message Queue] Flush buffered messages
      if (session.messageQueue && session.messageQueue.length > 0) {
        console.log(`Flushing ${session.messageQueue.length} messages to ${sessionID}`);
        session.messageQueue.forEach((msg) => {
          socket.emit('receive_message', msg);
        });
        session.messageQueue = [];
      }
    } else {
      // If they were waiting, update queue reference
      const queueItem = waitingQueue.find(q => q.sessionID === sessionID);
      if (queueItem) queueItem.socket = socket;
    }

  } else {
    // New Session
    sessionMap.set(sessionID, { 
      socketId: socket.id, 
      roomID: null, 
      userData: null, 
      timer: null,
      partnerSessionID: null,
      messageQueue: []
    });
  }

  socket.onAny(() => {
    socket.lastActive = Date.now();
  });

  // --- SEARCH LOGIC (Tiered: 3s Priority -> 2s Random) ---
  socket.on('find_partner', (userData) => {
    socket.userData = userData;

    // [FEATURE: Hard Reset]
    if (sessionMap.has(socket.sessionID)) {
      const session = sessionMap.get(socket.sessionID);
      session.userData = userData;
      if (session.roomID) {
        socket.leave(session.roomID);
        session.roomID = null;
      }
      session.partnerSessionID = null;
      session.messageQueue = [];
    }

    removeFromQueue(socket.sessionID);

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

    // [FEATURE: Tiered Waiting] Phase 1 (3 Seconds)
    setTimeout(() => {
      const currentEntry = waitingQueue.find(u => u.sessionID === socket.sessionID);
      if (!currentEntry || currentEntry.isMatched) return;

      const candidates = waitingQueue.filter(u => u.sessionID !== socket.sessionID && !u.isMatched);
      
      // A. Priority Match
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

      // [FEATURE: Tiered Waiting] Phase 2 (Wait 2 more seconds)
      setTimeout(() => {
        const reCheckEntry = waitingQueue.find(u => u.sessionID === socket.sessionID);
        if (!reCheckEntry || reCheckEntry.isMatched) return;

        reCheckEntry.openToAny = true;

        const openCandidates = waitingQueue.filter(u => u.sessionID !== socket.sessionID && !u.isMatched);
        
        const anyMatch = openCandidates.find(u => {
          if (u.openToAny) return true; 
          return u.userData.field === userData.field;
        });

        if (anyMatch) {
          reCheckEntry.isMatched = true;
          anyMatch.isMatched = true;
          executeMatch(socket.sessionID, anyMatch.sessionID);
        }

      }, PHASE_2_DELAY);

    }, AD_DELAY_MS);
  });

  socket.on('send_message', (messageData) => {
    const session = sessionMap.get(socket.sessionID);
    if (!session || !session.roomID) return;

    // [FEATURE: Message Queue] Check if partner is connected
    const partnerSessionID = session.partnerSessionID;
    const partnerSession = sessionMap.get(partnerSessionID);

    const msgPayload = {
      text: messageData.text,
      type: 'stranger',
      replyTo: messageData.replyTo,
      timestamp: messageData.timestamp
    };

    let sent = false;

    if (partnerSession && partnerSession.socketId) {
      const partnerSocket = io.sockets.sockets.get(partnerSession.socketId);
      
      if (partnerSocket && partnerSocket.connected) {
        if (!socket.rooms.has(session.roomID)) socket.join(session.roomID);
        
        socket.to(session.roomID).emit('receive_message', msgPayload);
        sent = true;
      }
    }

    // Buffer if offline
    if (!sent && partnerSession) {
      console.log(`Buffering message for ${partnerSessionID}`);
      if (!partnerSession.messageQueue) partnerSession.messageQueue = [];
      partnerSession.messageQueue.push(msgPayload);
    }
  });

  socket.on('typing', (isTyping) => {
    const session = sessionMap.get(socket.sessionID);
    if (session && session.roomID) {
      socket.to(session.roomID).emit('partner_typing', isTyping);
    }
  });

  // [FEATURE: Manual Disconnect Fix]
  socket.on('disconnect_partner', () => {
    const session = sessionMap.get(socket.sessionID);
    if (session && session.roomID) {
      socket.to(session.roomID).emit('partner_disconnected');
      io.in(session.roomID).socketsLeave(session.roomID);
      session.roomID = null;
      session.partnerSessionID = null;
      session.messageQueue = [];
    }
    removeFromQueue(socket.sessionID);
  });

  // [FEATURE: Infinite Session Persistence (until 24h)]
  socket.on('disconnect', (reason) => {
    console.log(`Disconnected: ${socket.id} (${reason})`);

    if (sessionMap.has(socket.sessionID)) {
      const session = sessionMap.get(socket.sessionID);

      // Stale Check: Did they already reconnect elsewhere?
      if (session.socketId !== socket.id) return;
      
      removeFromQueue(socket.sessionID);

      if (session.roomID) {
        // Tell partner "Reconnecting..."
        socket.to(session.roomID).emit('partner_reconnecting_server');
        
        // Start 24 Hour Timer before actually killing the session
        session.timer = setTimeout(() => {
          console.log(`24h Grace period expired for ${socket.sessionID}`);
          cleanupSession(socket.sessionID);
        }, RECONNECT_GRACE_PERIOD);
      } else {
        // If not in a room, we can keep the session ID valid for reconnection
        // but we don't need a timer because there's no chat state to preserve.
        // We leave it in sessionMap until the next server restart or manual cleanup.
      }
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SERVER RUNNING ON PORT ${PORT}`);
});