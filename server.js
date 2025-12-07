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

// 1. AUTO-DISCONNECT: If users don't type/click for 10 minutes, kill the chat.
const INACTIVITY_LIMIT = 10 * 60 * 1000; 

// 2. BACKGROUND PERSISTENCE: If they close the app/tab, wait 24 hours before giving up.
// This allows them to Alt-Tab, play a game, and come back without losing the chat.
const RECONNECT_GRACE_PERIOD = 24 * 60 * 60 * 1000; 

const PHASE_1_DELAY = 3000; // 3s Wait for Ad/Priority
const PHASE_2_DELAY = 2000; // 2s Wait for Random

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

// --- IDLE CHECKER (AUTO-DISCONNECT) ---
setInterval(() => {
  const now = Date.now();
  io.sockets.sockets.forEach((socket) => {
    // If socket is connected BUT hasn't done anything for 10 mins -> Disconnect
    if (socket.connected && socket.lastActive && (now - socket.lastActive > INACTIVITY_LIMIT)) {
      console.log(`Auto-disconnecting idle user: ${socket.id}`);
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

  // --- RECONNECTION HANDLER ---
  if (sessionMap.has(sessionID)) {
    const session = sessionMap.get(sessionID);
    
    session.socketId = socket.id;
    socket.userData = session.userData;
    socket.roomID = session.roomID;

    // Cancel death timer
    if (session.timer) {
      console.log(`Restored session: ${sessionID}`);
      clearTimeout(session.timer);
      session.timer = null;
    }

    if (session.roomID) {
      socket.join(session.roomID);
      socket.to(session.roomID).emit('partner_connected'); 
      socket.emit('session_restored', { status: 'connected' });

      if (session.messageQueue && session.messageQueue.length > 0) {
        console.log(`Flushing ${session.messageQueue.length} messages to ${sessionID}`);
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
      messageQueue: []
    });
  }

  // Update "lastActive" on ANY interaction (typing, message, etc)
  socket.onAny(() => {
    socket.lastActive = Date.now();
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

      const candidates = waitingQueue.filter(u => u.sessionID !== socket.sessionID && !u.isMatched);
      
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

    }, PHASE_1_DELAY); // 3s Ad Delay
  });

  socket.on('send_message', (messageData) => {
    const session = sessionMap.get(socket.sessionID);
    if (!session || !session.roomID) return;

    const partnerSessionID = session.partnerSessionID;
    const partnerSession = sessionMap.get(partnerSessionID);

    const msgPayload = {
      text: messageData.text,
      audio: messageData.audio, // --- ADDED AUDIO FIELD HERE ---
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

  socket.on('send_reaction', (reactionData) => {
    const session = sessionMap.get(socket.sessionID);
    if (session && session.roomID) {
      socket.to(session.roomID).emit('receive_reaction', {
        messageID: reactionData.messageID,
        reaction: reactionData.reaction
      });
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
      
      if (session.socketId !== socket.id) return; // Ignore stale
      
      removeFromQueue(socket.sessionID);

      if (session.roomID) {
        socket.to(session.roomID).emit('partner_reconnecting_server');
        
        // Background persistence (24h)
        session.timer = setTimeout(() => {
          console.log(`Grace period expired for ${socket.sessionID}`);
          cleanupSession(socket.sessionID);
        }, RECONNECT_GRACE_PERIOD);
      } else {
        // If user wasn't in a chat, we can be more aggressive with cleanup 
        // or let the queue handle it
      }
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SERVER RUNNING ON PORT ${PORT}`);
});