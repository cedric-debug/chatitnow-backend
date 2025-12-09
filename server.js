const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');

const app = express();
app.use(cors());

app.get("/", (req, res) => {
  res.status(200).send("ChatItNow Server is Running!");
});

const server = http.createServer(app);
const PORT = process.env.PORT || 3001;

// --- CONFIGURATION ---
const RECONNECT_GRACE_PERIOD = 24 * 60 * 60 * 1000; 
const PHASE_1_DELAY = 3000; 
const PHASE_2_DELAY = 2000; 
const TIMEOUT_DURATION = 15 * 60 * 1000; // 15 Minutes in milliseconds

const io = new Server(server, {
  maxHttpBufferSize: 1e8, // 100MB limit
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

let waitingQueue = []; 
const sessionMap = new Map(); 

function removeFromQueue(sessionID) {
  waitingQueue = waitingQueue.filter(u => u.sessionID !== sessionID);
}

function getSocketFromSession(sessionID) {
  const session = sessionMap.get(sessionID);
  if (!session || !session.socketId) return null;
  return io.sockets.sockets.get(session.socketId);
}

// Check if User A has timed out User B (or vice versa)
function isRestricted(sessionID1, sessionID2) {
  const s1 = sessionMap.get(sessionID1);
  const s2 = sessionMap.get(sessionID2);
  const now = Date.now();

  // Check if 1 timed out 2
  if (s1 && s1.timeouts && s1.timeouts[sessionID2]) {
    if (now < s1.timeouts[sessionID2]) return true; // Still active
    delete s1.timeouts[sessionID2]; // Expired
  }

  // Check if 2 timed out 1
  if (s2 && s2.timeouts && s2.timeouts[sessionID1]) {
    if (now < s2.timeouts[sessionID1]) return true; // Still active
    delete s2.timeouts[sessionID1]; // Expired
  }

  return false;
}

function cleanupSession(sessionID) {
  if (!sessionMap.has(sessionID)) return;
  const session = sessionMap.get(sessionID);
  if (session.timer) clearTimeout(session.timer);
  
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

  if (!socket1 || !socket2) {
    if (socket1) { const entry = waitingQueue.find(u => u.sessionID === sessionID1); if (entry) entry.isMatched = false; }
    if (socket2) { const entry = waitingQueue.find(u => u.sessionID === sessionID2); if (entry) entry.isMatched = false; }
    return;
  }

  const roomID = `${socket1.id}#${socket2.id}`;
  
  socket1.join(roomID);
  socket2.join(roomID);
  
  socket1.roomID = roomID;
  socket2.roomID = roomID;

  const s1 = sessionMap.get(sessionID1);
  const s2 = sessionMap.get(sessionID2);
  
  if(s1) { s1.roomID = roomID; s1.partnerSessionID = sessionID2; s1.messageQueue = []; }
  if(s2) { s2.roomID = roomID; s2.partnerSessionID = sessionID1; s2.messageQueue = []; }

  removeFromQueue(sessionID1);
  removeFromQueue(sessionID2);

  const user1Data = socket1.userData || {};
  const user2Data = socket2.userData || {};

  io.to(socket1.id).emit('matched', {
    name: user2Data.username || 'Stranger',
    field: user2Data.field || '',
    roomID: roomID,
    partnerReadReceipts: s2.readReceipts,
    partnerPublicKey: user2Data.publicKey
  });

  io.to(socket2.id).emit('matched', {
    name: user1Data.username || 'Stranger',
    field: user1Data.field || '',
    roomID: roomID,
    partnerReadReceipts: s1.readReceipts,
    partnerPublicKey: user1Data.publicKey
  });
}

io.on('connection', (socket) => {
  const sessionID = socket.handshake.auth.sessionID;
  
  if (!sessionID) {
    socket.disconnect();
    return;
  }

  socket.sessionID = sessionID;
  socket.lastActive = Date.now();

  console.log(`Connected: ${socket.id}`);

  if (sessionMap.has(sessionID)) {
    const session = sessionMap.get(sessionID);
    session.socketId = socket.id;
    socket.userData = session.userData;
    socket.roomID = session.roomID;

    // Ensure timeouts object exists for old sessions
    if (!session.timeouts) session.timeouts = {};

    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }

    if (session.roomID) {
      socket.join(session.roomID);
      socket.to(session.roomID).emit('partner_connected'); 
      socket.emit('session_restored', { status: 'connected' });

      const partnerID = session.partnerSessionID;
      const partnerSession = sessionMap.get(partnerID);
      if (partnerSession) {
          socket.emit('partner_receipt_setting', partnerSession.readReceipts);
      }

      if (session.messageQueue && session.messageQueue.length > 0) {
        session.messageQueue.forEach((msg) => {
          socket.emit('receive_message', msg);
        });
        session.messageQueue = [];
      }
    } else {
      const queueItem = waitingQueue.find(q => q.sessionID === sessionID);
      if (queueItem) queueItem.socket = socket;
    }

  } else {
    sessionMap.set(sessionID, { 
      socketId: socket.id, 
      roomID: null, 
      userData: null, 
      timer: null,
      partnerSessionID: null,
      messageQueue: [],
      readReceipts: true,
      timeouts: {} // Store timed out sessionIDs here
    });
  }

  socket.onAny(() => { socket.lastActive = Date.now(); });

  // --- NEW: TIMEOUT HANDLER ---
  socket.on('timeout_user', () => {
    const session = sessionMap.get(socket.sessionID);
    if (!session || !session.partnerSessionID) return;

    const targetID = session.partnerSessionID;
    
    // Add to timeout list with timestamp
    session.timeouts[targetID] = Date.now() + TIMEOUT_DURATION;

    // Trigger disconnect flow similar to 'disconnect_partner'
    if (session.roomID) {
      socket.to(session.roomID).emit('partner_disconnected');
      io.in(session.roomID).socketsLeave(session.roomID);
      session.roomID = null;
      session.partnerSessionID = null;
      session.messageQueue = [];
    }
    removeFromQueue(socket.sessionID);
    
    // Also clear partner
    const partnerSession = sessionMap.get(targetID);
    if(partnerSession) {
        partnerSession.roomID = null;
        partnerSession.partnerSessionID = null;
        removeFromQueue(targetID);
    }
  });

  socket.on('find_partner', (userData) => {
    socket.userData = userData; 
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

    setTimeout(() => {
      const currentEntry = waitingQueue.find(u => u.sessionID === socket.sessionID);
      if (!currentEntry || currentEntry.isMatched) return;

      // Filter candidates: Exclude self, already matched, AND restricted/timed-out users
      const candidates = waitingQueue.filter(u => 
        u.sessionID !== socket.sessionID && 
        !u.isMatched &&
        !isRestricted(socket.sessionID, u.sessionID) // <--- CHECK TIMEOUTS
      );
      
      if (!isGenericField) {
        const exactMatch = candidates.find(u => 
          u.userData.field === userData.field && u.userData.field !== '' && u.userData.field !== 'Others'
        );
        if (exactMatch) {
          currentEntry.isMatched = true;
          exactMatch.isMatched = true;
          executeMatch(socket.sessionID, exactMatch.sessionID);
          return;
        }
      }

      setTimeout(() => {
        const reCheckEntry = waitingQueue.find(u => u.sessionID === socket.sessionID);
        if (!reCheckEntry || reCheckEntry.isMatched) return;
        reCheckEntry.openToAny = true;
        
        // Re-filter with restriction check
        const openCandidates = waitingQueue.filter(u => 
          u.sessionID !== socket.sessionID && 
          !u.isMatched &&
          !isRestricted(socket.sessionID, u.sessionID) // <--- CHECK TIMEOUTS
        );
        
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
    }, PHASE_1_DELAY);
  });

  socket.on('send_message', (messageData) => {
    const session = sessionMap.get(socket.sessionID);
    if (!session || !session.roomID) return;

    const partnerSessionID = session.partnerSessionID;
    const partnerSession = sessionMap.get(partnerSessionID);

    const msgPayload = {
      encrypted: messageData.encrypted,
      isNSFW: messageData.isNSFW,
      type: 'stranger',
      replyTo: messageData.replyTo,
      timestamp: messageData.timestamp,
      id: messageData.id
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

    if (!sent && partnerSession) {
      if (!partnerSession.messageQueue) partnerSession.messageQueue = [];
      partnerSession.messageQueue.push(msgPayload);
    }
  });

  socket.on('toggle_read_receipts', (isEnabled) => {
    const session = sessionMap.get(socket.sessionID);
    if(session) {
      session.readReceipts = isEnabled;
      if(session.roomID) {
        socket.to(session.roomID).emit('partner_receipt_setting', isEnabled);
      }
    }
  });

  socket.on('mark_read', (messageID) => {
    const session = sessionMap.get(socket.sessionID);
    if (!session || !session.roomID || !session.partnerSessionID) return;

    const partnerSession = sessionMap.get(session.partnerSessionID);
    if (session.readReceipts && partnerSession && partnerSession.readReceipts) {
       socket.to(session.roomID).emit('message_read_by_partner', messageID);
    }
  });

  socket.on('send_reaction', (reactionData) => {
    const session = sessionMap.get(socket.sessionID);
    if (session && session.roomID) {
      socket.to(session.roomID).emit('receive_reaction', reactionData);
    }
  });

  socket.on('typing', (isTyping) => {
    const session = sessionMap.get(socket.sessionID);
    if (session && session.roomID) {
      socket.to(session.roomID).emit('partner_typing', isTyping);
    }
  });

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

  socket.on('disconnect', (reason) => {
    console.log(`Disconnected: ${socket.id}`);
    if (sessionMap.has(socket.sessionID)) {
      const session = sessionMap.get(socket.sessionID);
      if (session.socketId !== socket.id) return; 
      
      removeFromQueue(socket.sessionID);

      if (session.roomID) {
        socket.to(session.roomID).emit('partner_reconnecting_server');
        session.timer = setTimeout(() => {
          console.log(`Grace period expired for ${socket.sessionID}`);
          cleanupSession(socket.sessionID);
        }, RECONNECT_GRACE_PERIOD);
      }
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SERVER RUNNING ON PORT ${PORT}`);
});