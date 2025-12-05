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
const INACTIVITY_LIMIT = 10 * 60 * 1000; 
const RECONNECT_GRACE_PERIOD = 3 * 60 * 1000; 
const AD_DELAY_MS = 3000; 

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
// We store just Session IDs in the queue to keep it lightweight
let waitingQueue = []; 
// Session Map holds the heavy data: { socketId, roomID, userData, timer }
const sessionMap = new Map(); 

// --- HELPER FUNCTIONS ---

function removeFromQueue(sessionID) {
  waitingQueue = waitingQueue.filter(id => id !== sessionID);
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

function attemptMatch(initiatorSessionID) {
  const initiator = sessionMap.get(initiatorSessionID);
  if (!initiator) return;

  // Filter candidates (exclude self)
  const candidates = waitingQueue.filter(id => id !== initiatorSessionID);
  
  if (candidates.length === 0) return; // No one to match with

  const isGeneric = initiator.userData.field === '' || initiator.userData.field === 'Others';
  let partnerID = null;

  // 1. Try Priority Match
  if (!isGeneric) {
    partnerID = candidates.find(id => {
      const s = sessionMap.get(id);
      return s && s.userData.field === initiator.userData.field;
    });
  }

  // 2. If no priority match, grab the longest waiting user (First in line)
  if (!partnerID) {
    partnerID = candidates[0];
  }

  // EXECUTE MATCH
  if (partnerID) {
    const partner = sessionMap.get(partnerID);
    
    // Double check validity
    if (!partner) {
      removeFromQueue(partnerID);
      return; // Retry next time
    }

    const roomID = `${initiatorSessionID}#${partnerID}`;
    
    // Update State
    initiator.roomID = roomID;
    partner.roomID = roomID;

    // Remove both from queue
    removeFromQueue(initiatorSessionID);
    removeFromQueue(partnerID);

    // Get Live Sockets
    const socket1 = io.sockets.sockets.get(initiator.socketId);
    const socket2 = io.sockets.sockets.get(partner.socketId);

    // Join & Notify
    if (socket1) {
      socket1.join(roomID);
      socket1.emit('matched', { name: partner.userData.username, field: partner.userData.field, roomID });
    }
    if (socket2) {
      socket2.join(roomID);
      socket2.emit('matched', { name: initiator.userData.username, field: initiator.userData.field, roomID });
    }

    console.log(`Matched: ${initiatorSessionID} & ${partnerID}`);
  }
}

// --- MAIN LOGIC ---
io.on('connection', (socket) => {
  const sessionID = socket.handshake.auth.sessionID;
  if (!sessionID) {
    socket.disconnect();
    return;
  }

  socket.sessionID = sessionID;
  console.log(`Connected: ${socket.id} (${sessionID})`);

  // --- RECONNECT ---
  if (sessionMap.has(sessionID)) {
    const session = sessionMap.get(sessionID);
    session.socketId = socket.id; // Update live socket ref
    socket.userData = session.userData; // Restore data

    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }

    if (session.roomID) {
      socket.join(session.roomID);
      socket.to(session.roomID).emit('partner_connected'); 
      socket.emit('session_restored');
    }
  } else {
    // New Session
    sessionMap.set(sessionID, { socketId: socket.id, roomID: null, userData: null, timer: null });
  }

  socket.on('find_partner', (userData) => {
    // 1. Save Data
    if (sessionMap.has(socket.sessionID)) {
      sessionMap.get(socket.sessionID).userData = userData;
    }
    socket.userData = userData;

    // 2. Ensure not already in queue
    removeFromQueue(socket.sessionID);
    
    // 3. Add to Queue
    waitingQueue.push(socket.sessionID);
    console.log(`Queue: ${waitingQueue.length} user(s)`);

    // 4. Wait 3s (Ad Delay) before attempting match
    setTimeout(() => {
      // Are we still waiting?
      if (waitingQueue.includes(socket.sessionID)) {
        attemptMatch(socket.sessionID);
      }
    }, AD_DELAY_MS);
  });

  socket.on('send_message', (data) => {
    const session = sessionMap.get(socket.sessionID);
    if (session && session.roomID) {
      // Force join if missing
      if (!socket.rooms.has(session.roomID)) socket.join(session.roomID);

      socket.to(session.roomID).emit('receive_message', {
        text: data.text,
        type: 'stranger',
        replyTo: data.replyTo,
        timestamp: data.timestamp
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
    cleanupSession(socket.sessionID);
  });

  socket.on('disconnect', () => {
    console.log(`Disconnected: ${socket.id}`);
    
    if (sessionMap.has(socket.sessionID)) {
      const session = sessionMap.get(socket.sessionID);

      // If in queue, remove immediately
      if (waitingQueue.includes(socket.sessionID)) {
        removeFromQueue(socket.sessionID);
      }
      // If in room, start grace period
      else if (session.roomID) {
        socket.to(session.roomID).emit('partner_reconnecting_server');
        session.timer = setTimeout(() => {
          cleanupSession(socket.sessionID);
        }, RECONNECT_GRACE_PERIOD);
      } 
      // If idle, delete
      else {
        sessionMap.delete(socket.sessionID);
      }
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SERVER RUNNING ON PORT ${PORT}`);
});