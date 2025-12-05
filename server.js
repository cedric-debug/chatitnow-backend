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

// --- STATE ---
// Queue Items: { sessionID, userData, status: 'pending' | 'ready', joinedAt, priorityField }
let waitingQueue = []; 
const sessionMap = new Map(); 

// --- HELPER FUNCTIONS ---

function getSocketBySession(sessionID) {
  const session = sessionMap.get(sessionID);
  if (!session || !session.socketId) return null;
  return io.sockets.sockets.get(session.socketId);
}

function cleanupSession(sessionID) {
  if (!sessionMap.has(sessionID)) return;
  const session = sessionMap.get(sessionID);
  
  if (session.timer) clearTimeout(session.timer);
  
  if (session.roomID) {
    io.to(session.roomID).emit('partner_disconnected');
    io.in(session.roomID).socketsLeave(session.roomID);
  }
  
  // Remove from queue
  waitingQueue = waitingQueue.filter(u => u.sessionID !== sessionID);
  sessionMap.delete(sessionID);
}

// --- MATCHMAKING LOGIC ---

function executeMatch(entry1, entry2) {
  const socket1 = getSocketBySession(entry1.sessionID);
  const socket2 = getSocketBySession(entry2.sessionID);

  // Validation: Are both still connected?
  if (!socket1 || !socket1.connected || !socket2 || !socket2.connected) {
    // Determine who died and cleanup
    if (!socket1 || !socket1.connected) cleanupSession(entry1.sessionID);
    if (!socket2 || !socket2.connected) cleanupSession(entry2.sessionID);
    return; // Abort match, survivors will be picked up next scan
  }

  // Double check they aren't already in a room
  if (socket1.roomID || socket2.roomID) return; 

  const roomID = `${socket1.id}#${socket2.id}`;
  
  // Join Room
  socket1.join(roomID);
  socket2.join(roomID);
  socket1.roomID = roomID;
  socket2.roomID = roomID;

  // Update Session Map
  if (sessionMap.has(entry1.sessionID)) sessionMap.get(entry1.sessionID).roomID = roomID;
  if (sessionMap.has(entry2.sessionID)) sessionMap.get(entry2.sessionID).roomID = roomID;

  // Remove from Queue
  waitingQueue = waitingQueue.filter(u => u.sessionID !== entry1.sessionID && u.sessionID !== entry2.sessionID);

  console.log(`Matched: ${entry1.userData.username} & ${entry2.userData.username}`);

  // Notify Users
  io.to(socket1.id).emit('matched', {
    name: entry2.userData.username || 'Stranger',
    field: entry2.userData.field || '',
    roomID: roomID
  });

  io.to(socket2.id).emit('matched', {
    name: entry1.userData.username || 'Stranger',
    field: entry1.userData.field || '',
    roomID: roomID
  });
}

// Scans the queue and pairs people up
function scanQueue() {
  if (waitingQueue.length < 2) return;

  // Sort by join time (Oldest first)
  waitingQueue.sort((a, b) => a.joinedAt - b.joinedAt);

  // We need a set to keep track of who got matched in this cycle so we don't match them twice
  const matchedSessionIDs = new Set();

  for (let i = 0; i < waitingQueue.length; i++) {
    const userA = waitingQueue[i];

    // Skip if already processed or not ready (still watching ad)
    if (matchedSessionIDs.has(userA.sessionID)) continue;
    if (userA.status !== 'ready') continue;

    const isGenericA = userA.userData.field === '' || userA.userData.field === 'Others';

    // Look for a partner in the rest of the queue
    for (let j = i + 1; j < waitingQueue.length; j++) {
      const userB = waitingQueue[j];

      // Skip if busy or not ready
      if (matchedSessionIDs.has(userB.sessionID)) continue;
      if (userB.status !== 'ready') continue;

      const isGenericB = userB.userData.field === '' || userB.userData.field === 'Others';
      
      let isMatch = false;

      // 1. Priority Logic: If both have fields, they must match
      if (!isGenericA && !isGenericB) {
        if (userA.userData.field === userB.userData.field) {
          isMatch = true;
        }
      } 
      // 2. Loose Logic: If one or both are generic, they match
      else {
        isMatch = true; 
      }

      if (isMatch) {
        matchedSessionIDs.add(userA.sessionID);
        matchedSessionIDs.add(userB.sessionID);
        executeMatch(userA, userB);
        break; // UserA found a partner, stop looking for B's
      }
    }
  }
}

// Run matchmaking scan every 1 second to catch anyone waiting
setInterval(scanQueue, 1000);

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

  // --- RECONNECTION ---
  if (sessionMap.has(sessionID)) {
    const session = sessionMap.get(sessionID);
    
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }

    session.socketId = socket.id;
    socket.userData = session.userData;
    socket.roomID = session.roomID;

    if (session.roomID) {
      socket.join(session.roomID);
      socket.to(session.roomID).emit('partner_connected'); 
      socket.emit('session_restored', { status: 'connected' });
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

  // --- SEARCH START ---
  socket.on('find_partner', (userData) => {
    socket.userData = userData;
    if (sessionMap.has(socket.sessionID)) {
      sessionMap.get(socket.sessionID).userData = userData;
    }

    // Ensure we aren't already in queue
    waitingQueue = waitingQueue.filter(u => u.sessionID !== socket.sessionID);

    // 1. Add to Queue with 'pending' status
    waitingQueue.push({ 
      sessionID: socket.sessionID, 
      userData: userData, 
      status: 'pending', 
      joinedAt: Date.now() 
    });

    // 2. Wait for Ad Delay, then mark ready
    setTimeout(() => {
      // Find them in the queue (if they haven't left)
      const entry = waitingQueue.find(u => u.sessionID === socket.sessionID);
      if (entry) {
        entry.status = 'ready'; // Now the Scan Interval will pick them up
        scanQueue(); // Trigger immediate scan just in case
      }
    }, AD_DELAY_MS);
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

  socket.on('disconnect_partner', () => {
    cleanupSession(socket.sessionID);
  });

  socket.on('disconnect', (reason) => {
    console.log(`Disconnected: ${socket.id}`);

    if (sessionMap.has(socket.sessionID)) {
      const session = sessionMap.get(socket.sessionID);
      
      // Remove from queue immediately if disconnected while searching
      waitingQueue = waitingQueue.filter(u => u.sessionID !== socket.sessionID);

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