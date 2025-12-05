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
const AD_DELAY_MS = 3000; // 3 Seconds mandatory wait

// --- SOCKET SERVER SETUP ---
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
    const room = io.sockets.adapter.rooms.get(session.roomID);
    if (room) {
      io.in(session.roomID).socketsLeave(session.roomID);
    }
  }
  
  removeFromQueue(sessionID);
  sessionMap.delete(sessionID);
}

// Actual connection logic
function executeMatch(socket1, socket2) {
  // Verify connectivity
  if (!socket1.connected || !socket2.connected) {
    // If one failed, put the survivor back in queue (simple retry)
    // For simplicity in this demo, we just abort. 
    return;
  }

  const roomID = `${socket1.id}#${socket2.id}`;
  
  socket1.join(roomID);
  socket2.join(roomID);
  
  socket1.roomID = roomID;
  socket2.roomID = roomID;

  // Update session map
  if (sessionMap.has(socket1.sessionID)) sessionMap.get(socket1.sessionID).roomID = roomID;
  if (sessionMap.has(socket2.sessionID)) sessionMap.get(socket2.sessionID).roomID = roomID;

  // Remove from queue
  removeFromQueue(socket1.sessionID);
  removeFromQueue(socket2.sessionID);

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
    
    if (session.timer) {
      console.log(`Restored session: ${sessionID}`);
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
    } else {
      // If they were in queue, update socket ref
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

  // --- SEARCH LOGIC (AD DELAY + PRIORITY) ---
  socket.on('find_partner', (userData) => {
    socket.userData = userData;
    if (sessionMap.has(socket.sessionID)) {
      sessionMap.get(socket.sessionID).userData = userData;
    }

    // Clean start
    removeFromQueue(socket.sessionID);

    const isGenericField = userData.field === '' || userData.field === 'Others';

    // 1. Add to Queue immediately
    const myEntry = { 
      sessionID: socket.sessionID, 
      socket: socket, 
      userData: userData, 
      openToAny: false, // Strict mode initially
      isMatched: false, // Lock flag
      joinedAt: Date.now() 
    };
    waitingQueue.push(myEntry);

    // 2. Try to find a PRIORITY match immediately
    if (!isGenericField) {
      const candidates = waitingQueue.filter(u => u.sessionID !== socket.sessionID && !u.isMatched);
      const exactMatch = candidates.find(u => 
        u.userData.field === userData.field && 
        u.userData.field !== '' && 
        u.userData.field !== 'Others'
      );

      if (exactMatch) {
        // MATCH FOUND! 
        // But we must enforce the 3s delay for the UI to show the ad.
        myEntry.isMatched = true;
        exactMatch.isMatched = true;

        setTimeout(() => {
          executeMatch(socket, exactMatch.socket);
        }, AD_DELAY_MS);
        
        return; // Stop here, we found a match
      }
    }

    // 3. If no priority match found, wait for the AD DELAY (3s)
    setTimeout(() => {
      // Check if user disconnected or got matched by someone else in the meantime
      if (!socket.connected || myEntry.isMatched) return;

      // 4. Time is up! Switch to "Any" mode
      myEntry.openToAny = true;

      // 5. Look for ANY available partner
      // We match with:
      // a) Someone who also wants "Any" (openToAny = true)
      // b) Someone who wants "My Field" (Priority for them)
      const candidates = waitingQueue.filter(u => u.sessionID !== socket.sessionID && !u.isMatched);
      
      const match = candidates.find(u => {
        if (u.openToAny) return true; // They are desperate too
        return u.userData.field === userData.field; // I am their priority
      });

      if (match) {
        myEntry.isMatched = true;
        match.isMatched = true;
        executeMatch(socket, match.socket);
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
    console.log(`Disconnected: ${socket.id} (${reason})`);

    if (sessionMap.has(socket.sessionID)) {
      const session = sessionMap.get(socket.sessionID);
      
      // If waiting, remove immediately
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