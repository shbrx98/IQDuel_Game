const http = require("http");
const  next =  require ("next");
const {Server,socketIo, WebSocket: WebSocketType} = require("socket.io");
const { v4: uuidv4 } = require('uuid')


const server = http.createServer();


const TURN_TIME = 30;
const GRID_SIZE = 6;
const MAX_YELLOW_CARDS = 2;
const MAX_RED_CARDS = 1;
const TOTAL_BOXES = (GRID_SIZE - 1) * (GRID_SIZE - 1);
const ROOM_CLEANUP_INTERVAL = 15 * 60 * 1000; // 15 minutes in milliseconds

// Game State Interfaces
interface Coordinates {
  row: number;
  col: number;
}

interface Line {
  start: Coordinates;
  end: Coordinates;
  player: PlayerNumber;
}

interface Box {
  topLeft: Coordinates;
  player: PlayerNumber;
  id: string;
}

interface GameState {
  lines: Line[];
  boxes: Box[];
  currentPlayer: PlayerNumber;
  scores: { player1: number; player2: number };
  warnings: { player1: { yellow: number; red: number }; player2: { yellow: number; red: number } };
  gameStatus: "waiting" | "active" | "ended";
  winner: PlayerNumber | null;
  isPaused: boolean;
  timeLeft: number;
  soundEnabled: boolean;
  playerNames: { player1: string; player2: string };
}

type PlayerNumber = 1 | 2;

// Room Management
const gameRooms = new Map<string, Room>();
const matchmakingQueue: Player[] = [];

class Player {
  username: string;
  socketId: string;
  playerNumber: PlayerNumber | null;

  constructor(username: string, socketId: string, playerNumber: PlayerNumber | null = null) {
    this.username = username;
    this.socketId = socketId;
    this.playerNumber = playerNumber;
  }
}

class Room {
  id: string;
  players: Map<string, Player>;
  gameState: GameState;
  turnTimer?: NodeJS.Timeout;
  lastActivityTime: number;

  constructor(id: string) {
    this.id = id;
    this.players = new Map<string, Player>();
    this.gameState = {
      lines: [],
      boxes: [],
      currentPlayer: 1,
      scores: { player1: 0, player2: 0 },
      warnings: { player1: { yellow: 0, red: 0 }, player2: { yellow: 0, red: 0 } },
      gameStatus: "waiting",
      winner: null,
      isPaused: false,
      timeLeft: TURN_TIME,
      soundEnabled: true,
      playerNames: { player1: "در انتظار...", player2: "در انتظار..." }
    };
    this.lastActivityTime = Date.now();
  }

  addPlayer(player: Player) {
    this.players.set(player.socketId, player);
    this.updateActivityTime();
  }

  removePlayer(socketId: string) {
    this.players.delete(socketId);
    this.updateActivityTime();
  }

  isFull(): boolean {
    return this.players.size >= 2;
  }

  isEmpty(): boolean {
    return this.players.size === 0;
  }

  getPlayerByNumber(playerNumber: PlayerNumber): Player | undefined {
    return Array.from(this.players.values()).find(p => p.playerNumber === playerNumber);
  }

  updateActivityTime() {
    this.lastActivityTime = Date.now();
  }

  isInactive(maxInactiveTime: number): boolean {
    return Date.now() - this.lastActivityTime > maxInactiveTime;
  }

  clearTurnTimer() {
    if (this.turnTimer) {
      clearInterval(this.turnTimer);
      this.turnTimer = undefined;
    }
  }

  makeRandomMove(io:typeof Server) {
    const availableMoves = getAvailableMoves(this.gameState);
    if (availableMoves.length === 0) return null;

    const randomMoveIndex = Math.floor(Math.random() * availableMoves.length);
    const randomMove = availableMoves[randomMoveIndex];

    this.gameState.lines.push(randomMove);
    this.updateActivityTime();

    const newBoxes = checkForBoxes(this.gameState.lines);
    const boxesCompleted = newBoxes.length - this.gameState.boxes.length;

    this.gameState.boxes = newBoxes;
    if (boxesCompleted > 0) {
      this.gameState.scores[`player${this.gameState.currentPlayer}`] += boxesCompleted;
    } else {
      this.gameState.currentPlayer = this.gameState.currentPlayer === 1 ? 2 : 1;
    }

    if (this.gameState.boxes.length >= TOTAL_BOXES) {
      this.gameState.gameStatus = "ended";
      this.gameState.winner = this.gameState.scores.player1 > this.gameState.scores.player2 ? 1 :
                            this.gameState.scores.player2 > this.gameState.scores.player1 ? 2 : null;
    }

    io.to(this.id).emit("random_move_played", {
      move: randomMove,
      message: `زمان بازیکن ${this.gameState.currentPlayer} به پایان رسید. یک حرکت تصادفی انجام شد.`
    });

    io.to(this.id).emit("game_update", { gameState: this.gameState });

    return randomMove;
  }

  startTurnTimer(io:typeof Server) {
    this.clearTurnTimer();

    this.gameState.timeLeft = TURN_TIME;
    io.to(this.id).emit("timer_update", { 
      timeLeft: this.gameState.timeLeft,
      progress: (this.gameState.timeLeft / TURN_TIME) * 100 
    });

    this.turnTimer = setInterval(() => {
      this.gameState.timeLeft--;

      io.to(this.id).emit("timer_update", { 
        timeLeft: this.gameState.timeLeft,
        progress: (this.gameState.timeLeft / TURN_TIME) * 100 
      });

      if (this.gameState.timeLeft <= 0) {
        this.clearTurnTimer();

        if (this.gameState.gameStatus === "active") {
          const randomMove = this.makeRandomMove(io);

          if (this.gameState.gameStatus === "active") {
            this.startTurnTimer(io);
          }
        }
      }
    }, 1000);
  }
}

function getAvailableMoves(gameState: GameState): Line[] {
  const availableMoves: Line[] = [];

  for (let row = 0; row < GRID_SIZE; row++) {
    for (let col = 0; col < GRID_SIZE; col++) {
      // Horizontal lines
      if (col < GRID_SIZE - 1) {
        const horizontalLine: Line = {
          start: { row, col },
          end: { row, col: col + 1 },
          player: gameState.currentPlayer
        };
        if (!isLineAlreadyDrawn(gameState, horizontalLine)) {
          availableMoves.push(horizontalLine);
        }
      }

      // Vertical lines
      if (row < GRID_SIZE - 1) {
        const verticalLine: Line = {
          start: { row, col },
          end: { row: row + 1, col },
          player: gameState.currentPlayer
        };
        if (!isLineAlreadyDrawn(gameState, verticalLine)) {
          availableMoves.push(verticalLine);
        }
      }
    }
  }

  return availableMoves;
}

function isLineAlreadyDrawn(gameState: GameState, move: Line): boolean {
  return gameState.lines.some(line =>
    (line.start.row === move.start.row && line.start.col === move.start.col &&
      line.end.row === move.end.row && line.end.col === move.end.col) ||
    (line.start.row === move.end.row && line.start.col === move.end.col &&
      line.end.row === move.start.row && line.end.col === move.start.col)
  );
}

function checkForBoxes(lines: Line[]): Box[] {
  const boxes: Box[] = [];

  for (let row = 0; row < GRID_SIZE - 1; row++) {
    for (let col = 0; col < GRID_SIZE - 1; col++) {
      const topLeft = { row, col };
      const topRight = { row, col: col + 1 };
      const bottomLeft = { row: row + 1, col };
      const bottomRight = { row: row + 1, col: col + 1 };

      const topLine = findLine(lines, topLeft, topRight);
      const rightLine = findLine(lines, topRight, bottomRight);
      const bottomLine = findLine(lines, bottomLeft, bottomRight);
      const leftLine = findLine(lines, topLeft, bottomLeft);

      if (topLine && rightLine && bottomLine && leftLine) {
        const lastLine = [topLine, rightLine, bottomLine, leftLine].reduce((latest, line) => 
          lines.indexOf(line) > lines.indexOf(latest) ? line : latest
        );
        
        boxes.push({
          topLeft,
          player: lastLine.player,
          id: `box-${topLeft.row}-${topLeft.col}-${uuidv4().slice(0, 8)}`
        });
      }
    }
  }

  return boxes;
}

function findLine(lines: Line[], start: Coordinates, end: Coordinates): Line | undefined {
  return lines.find(line =>
    (line.start.row === start.row && line.start.col === start.col &&
      line.end.row === end.row && line.end.col === end.col) ||
    (line.start.row === end.row && line.start.col === end.col &&
      line.end.row === start.row && line.end.col === start.col)
  );
}

function handlePlayerLeaving(io: typeof Server, socketId: string, roomId: string): boolean {
  const room = gameRooms.get(roomId);
  if (!room) return false;

  const player = room.players.get(socketId);
  room.removePlayer(socketId);

  if (room.gameState.gameStatus === "active") {
    room.gameState.gameStatus = "ended";
    
    if (room.players.size === 1) {
      const remainingPlayer = Array.from(room.players.values())[0];
      if (remainingPlayer?.playerNumber) {
        room.gameState.winner = remainingPlayer.playerNumber;
      }
    }
    
    room.clearTurnTimer();
  }

  if (player) {
    io.to(roomId).emit("player_left", { 
      message: `${player.username} از بازی خارج شده است.`,
      gameState: room.gameState
    });
  }

  if (room.isEmpty()) {
    gameRooms.delete(roomId);
  }

  return true;
}

function createAndJoinRoom(players: Player[], io: typeof Server) {
  const roomId = uuidv4();
  const room = new Room(roomId);

  players.forEach((player, index) => {
    player.playerNumber = (index + 1) as PlayerNumber;
    room.addPlayer(player);
    io.sockets.sockets.get(player.socketId)?.join(roomId);
  });

  if (players[0]) room.gameState.playerNames.player1 = players[0].username;
  if (players[1]) room.gameState.playerNames.player2 = players[1].username;

  room.gameState.gameStatus = "active";
  room.startTurnTimer(io);

  gameRooms.set(roomId, room);

  io.to(roomId).emit("start_game", {
    gameState: room.gameState,
    playerNames: room.gameState.playerNames,
    roomId
  });
}


// Initialize server
const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOST_NAME || "localhost";
const port = parseInt(process.env.PORT || "4001", 10);
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

const io = new Server(server, {
  cors: {
    origin: "*",
  },
}); // تمام connection ها

io.on("connection", (socket: typeof WebSocketType) => { 
  // game codes
  console.log(`Client connected: ${socket.id}`);

  socket.on("join_queue", ({ username }:any, callback : any) => {
    try {
      const existingQueueIndex = matchmakingQueue.findIndex(p => p.socketId === socket.id);
      if (existingQueueIndex !== -1) {
        callback({ success: false, message: "شما قبلا در صف هستید" });
        return;
      }

      Array.from(gameRooms.values()).forEach(room => {
        if (room.players.has(socket.id)) {
          callback({ success: false, message: "شما قبلا در یک اتاق هستید" });
          return;
        }
      });

      const player = new Player(username, socket.id);
      matchmakingQueue.push(player);

      callback({ success: true, message: "وارد صف انتظار شدید" });

      if (matchmakingQueue.length >= 2) {
        const player1 = matchmakingQueue.shift();
        const player2 = matchmakingQueue.shift();
        if (player1 && player2) {
          createAndJoinRoom([player1, player2], io);
        }
      }
    } catch (error) {
      console.error('Join queue error:', error);
      callback({ success: false, message: "خطا در ورود به صف انتظار" });
    }
  });

  socket.on("make_move", ({ roomId, move }:any, callback:any) => {
    try {
      const room = gameRooms.get(roomId);
      if (!room) throw new Error('اتاق یافت نشد');
  
      const player = Array.from(room.players.values()).find(p => p.socketId === socket.id);
      if (!player) throw new Error('شما در این اتاق نیستید');
  
      if (room.gameState.currentPlayer !== player.playerNumber || 
          room.gameState.gameStatus !== "active") {
        throw new Error("نوبت شما نیست یا بازی فعال نیست");
      }
  
      if (isLineAlreadyDrawn(room.gameState, move)) {
        throw new Error("این خط قبلاً کشیده شده است");
      }
  
      room.clearTurnTimer();
      room.gameState.lines.push(move);
      room.updateActivityTime();
      
      const newBoxes = checkForBoxes(room.gameState.lines);
      const boxesCompleted = newBoxes.length - room.gameState.boxes.length;
  
      room.gameState.boxes = newBoxes;
      if (boxesCompleted > 0) {
        room.gameState.scores[`player${player.playerNumber}`] += boxesCompleted;
      } else {
        room.gameState.currentPlayer = player.playerNumber === 1 ? 2 : 1;
      }
  
      if (room.gameState.boxes.length >= TOTAL_BOXES) {
        room.gameState.gameStatus = "ended";
        room.gameState.winner = room.gameState.scores.player1 > room.gameState.scores.player2 ? 1 :
                               room.gameState.scores.player2 > room.gameState.scores.player1 ? 2 : null;
      }
  
      if (room.gameState.gameStatus === "active") {
        room.startTurnTimer(io);
      }
  
      io.to(room.id).emit("game_update", { gameState: room.gameState });
      callback({ success: true });
  
    } catch (error: any) {
      console.error('Move error:', error.message);
      callback({ success: false, message: error.message });
    }
  });

  socket.on("pause_game", ({ roomId }:any, callback:any) => {
    try {
      const room = gameRooms.get(roomId);
      if (!room) throw new Error('اتاق یافت نشد');
      if (!room.players.has(socket.id)) throw new Error('شما در این اتاق نیستید');

      room.gameState.isPaused = !room.gameState.isPaused;
      room.updateActivityTime();
      
      if (room.gameState.isPaused) {
        room.clearTurnTimer();
      } else if (room.gameState.gameStatus === "active") {
        room.startTurnTimer(io);
      }

      io.to(roomId).emit("game_update", { gameState: room.gameState });
      callback({ success: true });
    } catch (error: any) {
      console.error('Pause error:', error.message);
      callback({ success: false, message: error.message });
    }
  });

  socket.on("leave_room", ({ roomId }:any, callback:any) => {
    try {
      const success = handlePlayerLeaving(io, socket.id, roomId);
      if (success) {
        socket.leave(roomId);
        callback({ success: true });
      } else {
        callback({ success: false, message: "اتاق یافت نشد" });
      }
    } catch (error: any) {
      console.error('Leave room error:', error.message);
      callback({ success: false, message: error.message });
    }
  });

  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${socket.id}`);

    const queueIndex = matchmakingQueue.findIndex(p => p.socketId === socket.id);
    if (queueIndex !== -1) {
      matchmakingQueue.splice(queueIndex, 1);
    }

    gameRooms.forEach((room, roomId) => {
      if (room.players.has(socket.id)) {
        handlePlayerLeaving(io, socket.id, roomId);
      }
    });
  });

});

setInterval(() => {
  gameRooms.forEach((room, roomId) => {
    if (room.isEmpty() || room.isInactive(ROOM_CLEANUP_INTERVAL)) {
      room.clearTurnTimer();
      gameRooms.delete(roomId);
    }
  });
}, 60 * 1000);

const PORT = 4001;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`WebSocket available at ws://localhost:${PORT}`);
});

// httpServer.listen(port, () => {
//   console.log(`Server running on http://${hostname}:${port}`);
// });


  // دریافت دیتا به صورت buffer انجام می‌شود
  // socket.on("message", (data: any) => {
  //   console.log("client message ->", data.toString("utf-8"));
  //   // ارسال جواب دیتا به تمام connection ها
  //   io.clients.forEach(
  //     (client: { send: (arg0: any) => void; toString: () => any }) => {
  //       client.send(
  //         JSON.stringify({
  //           message: DataTransfer.toString(),
  //         })
  //       );
  //     }
  //   );
  // });