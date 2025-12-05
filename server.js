const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');

const app = express();
app.use(cors());

// Home Route
app.get("/", (req, res) => {
  res.send("ChatItNow Server is Running!");
});

const server = http.createServer(app);

// Cloud port configuration
const PORT = process.env.PORT || 3001;

const io = new Server(server, {
  // --- MOBILE STABILITY FIX ---
  connectionStateRecovery: {
    maxDisconnectionDuration: 10 * 60 * 1000,
    skipMiddlewares: true,
  },
  pingTimeout: 600000, 
  pingInterval: 25000,
  
  cors: {
    origin: [
      "https://chatitnow.com",
      "https://www.chatitnow.com",
      "http://localhost:5173", 
      "https://chatitnow-frontend.vercel.app"
    ],
    methods: ["GET", "POST"]
  }
});

let waitingQueue = [];

const matchUsers = (socket1, socket2) => {
  const roomID = `${socket1.id}#${socket2.id}`;
  socket1.join(roomID);
  socket2.join(roomID);
  socket1.roomID = roomID;
  socket2.roomID = roomID;

  // Remove both from queue
  waitingQueue = waitingQueue.filter(u => u.socket.id !== socket1.id && u.socket.id !== socket2.id);

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

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  if (socket.recovered) {
    console.log(`User ${socket.id} recovered connection`);
  }

  socket.on('find_partner', (userData) => {
    socket.userData = userData; 

    // Check if the user provided a specific field or if it's generic
    const isGenericField = userData.field === '' || userData.field === 'Others';

    // DELAY 1: Wait 3 seconds (Ad view time)
    setTimeout(() => {
      if (!socket.connected) return;

      // --- MATCHING LOGIC START ---

      // 1. PRIORITY MATCH: Only if the user has a SPECIFIC field
      if (!isGenericField) {
        const exactMatch = waitingQueue.find(user => 
          user.socket.id !== socket.id &&
          user.userData.field !== '' &&
          user.userData.field !== 'Others' && 
          user.userData.field === userData.field
        );

        if (exactMatch) {
          matchUsers(socket, exactMatch.socket);
          return;
        }
      }

      // 2. DESPERATION CHECK: Look for someone who has been waiting too long
      const desperateUser = waitingQueue.find(user => 
        user.socket.id !== socket.id &&
        user.openToAny === true
      );

      if (desperateUser) {
        matchUsers(socket, desperateUser.socket);
        return;
      }

      // 3. QUEUE USER
      const queueItem = {
        socket: socket,
        userData: userData,
        openToAny: false 
      };
      
      waitingQueue.push(queueItem);

      // --- DELAY 2: QUEUE WAIT TIMES ---
      
      // Config: 
      // Specific Field = 3s Priority + 2s Random Buffer = 5s Total
      // Generic Field  = 4s Wait -> Random
      
      const priorityWaitTime = isGenericField ? 4000 : 3000;

      setTimeout(() => {
        // Check if user is still connected and still in queue
        const currentEntry = waitingQueue.find(u => u.socket.id === socket.id);
        
        if (currentEntry) {
          // Phase 2: Mark as Open To Any
          currentEntry.openToAny = true; 
          
          // If it was a Specific Field, we add an extra 2s buffer before forcing a random match
          // giving a slight chance for another specific match to come in last second.
          const extraBuffer = isGenericField ? 0 : 2000;

          setTimeout(() => {
             // Final Check
             const finalEntry = waitingQueue.find(u => u.socket.id === socket.id);
             if (finalEntry) {
                // Scan for ANY available user
                const anyMatch = waitingQueue.find(u => u.socket.id !== socket.id);
                if (anyMatch) {
                  matchUsers(socket, anyMatch.socket);
                }
             }
          }, extraBuffer);
        }
      }, priorityWaitTime); 

    }, 3000); // Initial 3s Ad Delay
  });

  socket.on('send_message', (messageData) => {
    if (socket.roomID) {
      socket.to(socket.roomID).emit('receive_message', {
        text: messageData.text,
        type: 'stranger'
      });
    }
  });

  socket.on('typing', (isTyping) => {
    if (socket.roomID) {
      socket.to(socket.roomID).emit('partner_typing', isTyping);
    }
  });

  const handleDisconnect = (userSocket) => {
    waitingQueue = waitingQueue.filter(s => s.socket.id !== userSocket.id);

    if (userSocket.roomID) {
      userSocket.to(userSocket.roomID).emit('partner_disconnected');
      
      const room = io.sockets.adapter.rooms.get(userSocket.roomID);
      if (room) {
        for (const id of room) {
          const s = io.sockets.sockets.get(id);
          if (s) { s.leave(userSocket.roomID); s.roomID = null; }
        }
      }
      userSocket.roomID = null;
    }
  };

  socket.on('disconnect_partner', () => {
    handleDisconnect(socket);
  });

  socket.on('disconnect', (reason) => {
    console.log(`User ${socket.id} disconnected. Reason: ${reason}`);
    handleDisconnect(socket);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SERVER RUNNING ON PORT ${PORT}`);
});