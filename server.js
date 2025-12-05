const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');

const app = express();
app.use(cors());

app.get("/", (req, res) => {
  res.send("ChatItNow Server is Running!");
});

const server = http.createServer(app);
const PORT = process.env.PORT || 3001;

// 10 Minutes max session idle time
const INACTIVITY_LIMIT = 10 * 60 * 1000; 
// 1 Minute grace period for internet drops
const RECONNECT_GRACE_PERIOD = 60 * 1000; 

const io = new Server(server, {
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000, 
    skipMiddlewares: true,
  },
  pingTimeout: 60000, 
  pingInterval: 25000,
  cors: {
    origin: "*", // Allow all origins for easier debugging, restrict in production
    methods: ["GET", "POST"]
  }
});

let waitingQueue = [];

// Session Map: sessionID -> { socketId, roomID, userData, timer }
const sessionMap = new Map(); 

// --- IDLE CHECKER ---
setInterval(() => {
  const now = Date.now();
  io.sockets.sockets.forEach((socket) => {
    if (socket.lastActive && (now - socket.lastActive > INACTIVITY_LIMIT)) {
      socket.disconnect(true);
    }
  });
}, 60 * 1000);

const matchUsers = (socket1, socket2) => {
  // Check if sockets are still connected/valid
  if (!socket1 || !socket2) return;

  const roomID = `${socket1.id}#${socket2.id}`;
  
  socket1.join(roomID);
  socket2.join(roomID);
  
  socket1.roomID = roomID;
  socket2.roomID = roomID;

  // Update session map
  if (socket1.sessionID && sessionMap.has(socket1.sessionID)) sessionMap.get(socket1.sessionID).roomID = roomID;
  if (socket2.sessionID && sessionMap.has(socket2.sessionID)) sessionMap.get(socket2.sessionID).roomID = roomID;

  // Remove both from queue
  waitingQueue = waitingQueue.filter(u => u.sessionID !== socket1.sessionID && u.sessionID !== socket2.sessionID);

  io.to(socket1.id).emit('matched', {
    name: socket2.userData.username,
    field: socket2.userData.field,
    roomID: roomID
  });

  io.to(socket2.id).emit('matched', {
    name: socket1.userData.username,
    field: socket1.userData.field,
    roomID: roomID
  });
};

const cleanupSession = (sessionID) => {
  if (!sessionMap.has(sessionID)) return;
  const session = sessionMap.get(sessionID);
  
  if (session.timer) clearTimeout(session.timer);
  
  // Notify partner
  if (session.roomID) {
    io.to(session.roomID).emit('partner_disconnected');
    // Clear room data
    const room = io.sockets.adapter.rooms.get(session.roomID);
    if (room) {
      // Make everyone leave
      io.in(session.roomID).socketsLeave(session.roomID);
    }
  }
  
  // Remove from queue if they were waiting
  waitingQueue = waitingQueue.filter(u => u.sessionID !== sessionID);
  sessionMap.delete(sessionID);
};

io.on('connection', (socket) => {
  const sessionID = socket.handshake.auth.sessionID;
  
  if (!sessionID) {
    console.log("Rejected connection without sessionID");
    socket.disconnect();
    return;
  }

  socket.sessionID = sessionID;
  socket.lastActive = Date.now();

  console.log(`User connected: ${socket.id} (Session: ${sessionID})`);

  // --- RECONNECTION LOGIC ---
  if (sessionMap.has(sessionID)) {
    const session = sessionMap.get(sessionID);
    
    // Cancel any pending disconnect timer (Grace period success!)
    if (session.timer) {
      console.log(`Session ${sessionID} reconnected within grace period.`);
      clearTimeout(session.timer);
      session.timer = null;
    }

    // Update session with NEW socket ID
    session.socketId = socket.id;
    
    // Restore User Data to new socket
    socket.userData = session.userData;
    socket.roomID = session.roomID;

    // 1. IF IN ROOM: Re-join the room
    if (session.roomID) {
      socket.join(session.roomID);
      // Tell partner we are back
      socket.to(session.roomID).emit('partner_connected');
      // Tell myself I am back (optional state sync)
      socket.emit('rejoined_room', { name: 'Partner', status: 'connected' }); 
    } 
    
    // 2. IF IN QUEUE: Update the socket reference in the queue
    const queueIndex = waitingQueue.findIndex(q => q.sessionID === sessionID);
    if (queueIndex !== -1) {
      console.log(`Updating queue socket for ${sessionID}`);
      waitingQueue[queueIndex].socket = socket;
    }

  } else {
    // New Session Initialization
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

  socket.on('find_partner', (userData) => {
    socket.userData = userData;
    // Update session data
    if (sessionMap.has(socket.sessionID)) {
      sessionMap.get(socket.sessionID).userData = userData;
    }

    // Don't add to queue if already in it
    if (waitingQueue.find(q => q.sessionID === socket.sessionID)) return;

    const isGenericField = userData.field === '' || userData.field === 'Others';

    // Immediate Logic for finding partner
    const tryMatch = () => {
        if (!socket.connected) return;

        // Filter out self
        const potentialMatches = waitingQueue.filter(u => u.sessionID !== socket.sessionID);

        // 1. Priority Match
        if (!isGenericField) {
            const exactMatch = potentialMatches.find(u => 
                u.userData.field === userData.field && 
                u.userData.field !== '' && 
                u.userData.field !== 'Others'
            );
            if (exactMatch) {
                matchUsers(socket, exactMatch.socket);
                return;
            }
        }

        // 2. Any Match (if user is openToAny or desperate)
        // Simplified: Just match with the longest waiting user
        if (potentialMatches.length > 0) {
             const anyMatch = potentialMatches[0];
             matchUsers(socket, anyMatch.socket);
             return;
        }

        // 3. No match found, ensure we are in queue
        if (!waitingQueue.find(q => q.sessionID === socket.sessionID)) {
            waitingQueue.push({ 
                sessionID: socket.sessionID, 
                socket: socket, 
                userData: userData, 
                joinedAt: Date.now() 
            });
        }
    };

    // Attempt match after short delay to simulate "searching"
    setTimeout(tryMatch, 2000);
  });

  socket.on('send_message', (messageData) => {
    if (socket.roomID) {
      socket.to(socket.roomID).emit('receive_message', {
        text: messageData.text,
        type: 'stranger',
        replyTo: messageData.replyTo,
        timestamp: messageData.timestamp // Pass timestamp if sent from client
      });
    }
  });

  socket.on('typing', (isTyping) => {
    if (socket.roomID) {
      socket.to(socket.roomID).emit('partner_typing', isTyping);
    }
  });

  socket.on('disconnect_partner', () => {
    cleanupSession(socket.sessionID);
  });

  socket.on('disconnect', (reason) => {
    console.log(`User ${socket.id} disconnected (${reason})`);

    if (sessionMap.has(socket.sessionID)) {
      const session = sessionMap.get(socket.sessionID);
      
      // If user was just in queue, remove them immediately (no grace period needed for queue usually)
      // But if you want queue persistence, keep them. Here we remove to prevent ghost matches.
      waitingQueue = waitingQueue.filter(u => u.sessionID !== socket.sessionID);

      if (session.roomID) {
        // Notify partner of temporary disconnect
        socket.to(session.roomID).emit('partner_reconnecting_server');
        
        // Start Grace Period Timer
        session.timer = setTimeout(() => {
          console.log(`Grace period expired for ${socket.sessionID}`);
          cleanupSession(socket.sessionID);
        }, RECONNECT_GRACE_PERIOD);
      } else {
        // If not in a room, clean up immediately
        sessionMap.delete(socket.sessionID);
      }
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SERVER RUNNING ON PORT ${PORT}`);
});