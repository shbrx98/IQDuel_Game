import { Server } from "socket.io";
import next from "next";
import { createServer } from "node:http";
import { v4 as uuidv4 } from "uuid";
import mongoose from "mongoose";
import User from "./models/User";
import Game from "./models/Game";

// Constants
const TURN_TIME = 30;
const GRID_SIZE = 6;
const MAX_YELLOW_CARDS = 2;
const MAX_RED_CARDS = 1;
const TOTAL_BOXES = (GRID_SIZE - 1) * (GRID_SIZE - 1);
const ROOM_CLEANUP_INTERVAL = 15 * 60 * 1000; // 15 minutes in milliseconds

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/dotline";

mongoose.connect(MONGODB_URI)
  .then(() => console.log("Connected to MongoDB"))
  .catch(err => console.error("MongoDB connection error:", err));

// Game State Interfaces
interface Coordinates {
  row: number;
  col: number;
}

interface Line {
  start: Coordinates;
  end: Coordinates;
  player: PlayerNumber;
  timestamp?: Date;
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

interface PlayerData {
  userId?: mongoose.Types.ObjectId;
  username: string;
  phone?: string;
  ref?: string;
}

type PlayerNumber = 1 | 2;

// Room Management
const gameRooms = new Map<string, Room>();
const matchmakingQueue: Player[] = [];

class Player {
  username: string;
  socketId: string;
  playerNumber: PlayerNumber | null;
  userId?: mongoose.Types.ObjectId;
  phone?: string;
  ref?: string;

  constructor(
    username: string, 
    socketId: string, 
    playerNumber: PlayerNumber | null = null,
    userId?: mongoose.Types.ObjectId,
    phone?: string,
    ref?: string
  ) {
    this.username = username;
    this.socketId = socketId;
    this.playerNumber = playerNumber;
    this.userId = userId;
    this.phone = phone;
    this.ref = ref;
  }
}

class Room {
  id: string;
  players: Map<string, Player>;
  gameState: GameState;
  turnTimer?: NodeJS.Timeout;
  lastActivityTime: number;
  gameStartTime: Date;

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
    this.gameStartTime = new Date();
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

  makeRandomMove(io: Server) {
    const availableMoves = getAvailableMoves(this.gameState);
    if (availableMoves.length === 0) return null;

    const randomMoveIndex = Math.floor(Math.random() * availableMoves.length);
    const randomMove = availableMoves[randomMoveIndex];
    randomMove.timestamp = new Date();

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
      
      this.endGame();
    }

    io.to(this.id).emit("random_move_played", {
      move: randomMove,
      message: `زمان بازیکن ${this.gameState.currentPlayer} به پایان رسید. یک حرکت تصادفی انجام شد.`
    });

    io.to(this.id).emit("game_update", { gameState: this.gameState });

    return randomMove;
  }

  startTurnTimer(io: Server) {
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
          this.makeRandomMove(io);

          if (this.gameState.gameStatus === "active") {
            this.startTurnTimer(io);
          }
        }
      }
    }, 1000);
  }

  async saveGame() {
    try {
      const player1 = this.getPlayerByNumber(1);
      const player2 = this.getPlayerByNumber(2);

      if (!player1 || !player2) return;

   
      interface GameData {
        roomId: string;
        startedAt: Date;
        endedAt: Date;
        players: {
          userId?: mongoose.Types.ObjectId;
          playerNumber: number;
          username: string;
          phone?: string;
          ref?: string;
        }[];
        gameState: {
          lines: Line[];
          boxes: Box[];
          scores: { player1: number; player2: number };
          winner: PlayerNumber | null;
          duration: number;
        };
      }

      const gameData: GameData = {
        roomId: this.id,
        startedAt: this.gameStartTime,
        endedAt: new Date(),
        players: [
          {
            userId: player1.userId,
            playerNumber: 1,
            username: player1.username,
            phone: player1.phone,
            ref: player1.ref
          },
          {
            userId: player2.userId,
            playerNumber: 2,
            username: player2.username,
            phone: player2.phone,
            ref: player2.ref
          }
        ],
        gameState: {
          lines: this.gameState.lines,
          boxes: this.gameState.boxes,
          scores: this.gameState.scores,
          winner: this.gameState.winner,
          duration: (new Date().getTime() - this.gameStartTime.getTime()) / 1000 // duration in seconds
        }
      };

      await Game.create(gameData);
    } catch (error) {
      console.error("Error saving game:", error);
    }
  }

  async updatePlayerStats() {
    try {
      if (this.gameState.gameStatus !== "ended") return;
      
      const player1 = this.getPlayerByNumber(1);
      const player2 = this.getPlayerByNumber(2);

      if (!player1?.userId || !player2?.userId) return;

      // Update player 1 stats
      await User.findByIdAndUpdate(player1.userId, {
        $inc: {
          "statistics.totalGames": 1,
          "statistics.wins": this.gameState.winner === 1 ? 1 : 0,
          "statistics.losses": this.gameState.winner === 2 ? 1 : 0,
          "statistics.draws": this.gameState.winner === null ? 1 : 0,
          "statistics.totalScore": this.gameState.scores.player1
        }
      });

      // Update player 2 stats
      await User.findByIdAndUpdate(player2.userId, {
        $inc: {
          "statistics.totalGames": 1,
          "statistics.wins": this.gameState.winner === 2 ? 1 : 0,
          "statistics.losses": this.gameState.winner === 1 ? 1 : 0,
          "statistics.draws": this.gameState.winner === null ? 1 : 0,
          "statistics.totalScore": this.gameState.scores.player2
        }
      });

    } catch (error) {
      console.error("Error updating player stats:", error);
    }
  }

  endGame() {
    this.saveGame();
    this.updatePlayerStats();
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

async function handlePlayerLeaving(io: Server, socketId: string, roomId: string): Promise<boolean> {
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
    await room.endGame();
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

async function createAndJoinRoom(players: Player[], io: Server) {
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
const port = parseInt(process.env.PORT || "3001", 10);
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const httpServer = createServer((req, res) => {
    handle(req, res);
  });

  const io = new Server(httpServer, {
    cors: {
      origin: dev ? "*" : process.env.ALLOWED_ORIGINS?.split(',') || "http://localhost:3000",
      methods: ["GET", "POST"]
    }
  });

  io.on("connection", (socket) => {
    console.log(`Client connected: ${socket.id}`);

    interface CallbackResponse {
      success: boolean;
      message?: string;
      stats?: any;
      username?: string;
      chat?: any[];
    }

    socket.on("join_queue", async ({ username, phone }: { username: string; phone?: string }, callback: (response: CallbackResponse) => void) => {
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

        // Find or create user
        let user;
        if (phone) {
          user = await User.findOne({ phone });
          
          if (!user) {
            user = await User.create({
              phone,
              username,
              lastLogin: new Date()
            });
          } else {
            // Update last login
            await User.findByIdAndUpdate(user._id, { 
              lastLogin: new Date(),
              $set: { username } // Update username if needed
            });
          }
        }

        const player = new Player(
          username, 
          socket.id, 
          null, 
          user?._id, 
          phone,
          user?.ref
        );
        
        matchmakingQueue.push(player);

        callback({ success: true, message: "وارد صف انتظار شدید" });

        if (matchmakingQueue.length >= 2) {
          const player1 = matchmakingQueue.shift();
          const player2 = matchmakingQueue.shift();
          if (player1 && player2) {
            await createAndJoinRoom([player1, player2], io);
          }
        }
      } catch (error) {
        console.error('Join queue error:', error);
        callback({ success: false, message: "خطا در ورود به صف انتظار" });
      }
    });

    socket.on("make_move", async ({ roomId, move }: { roomId: string; move: Line }, callback: (response: CallbackResponse) => void) => {
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
        move.timestamp = new Date();
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
          
          await room.endGame();
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

    socket.on("pause_game", ({ roomId }: { roomId: string }, callback: (response: CallbackResponse) => void) => {
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

    socket.on("leave_room", async ({ roomId }: { roomId: string }, callback: (response: CallbackResponse) => void) => {
      try {
        const success = await handlePlayerLeaving(io, socket.id, roomId);
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

    socket.on("get_user_stats", async ({ phone }: { phone: string }, callback: (response: CallbackResponse) => void) => {
      try {
        if (!phone) {
          callback({ success: false, message: "شماره تلفن ارائه نشده است" });
          return;
        }

        const user = await User.findOne({ phone });
        if (!user) {
          callback({ success: false, message: "کاربر یافت نشد" });
          return;
        }

        callback({ 
          success: true, 
          stats: user.statistics,
          username: user.username
        });
      } catch (error: any) {
        console.error('Get stats error:', error.message);
        callback({ success: false, message: error.message });
      }
    });

    
    interface ChatMessage {
      sender: string;
      message: string;
      timestamp: Date;
    }

    socket.on("send_message", async ({ roomId, message }: { roomId: string; message: string }, callback: (response: CallbackResponse) => void) => {
      try {
        const room = gameRooms.get(roomId);
        if (!room) throw new Error('اتاق یافت نشد');
  
        const player = Array.from(room.players.values()).find(p => p.socketId === socket.id);
        if (!player) throw new Error('شما در این اتاق نیستید');
  
        // Save message in DB
        const chatMessage = {
          sender: player.userId,
          message,
          timestamp: new Date()
        };
  
        await Game.updateOne(
          { roomId },
          { $push: { chat: chatMessage } }
        );
  
        // Send message to all player in room
        io.to(roomId).emit("receive_message", {
          sender: player.username,
          message,
          timestamp: chatMessage.timestamp
        });
  
        callback({ success: true });
      } catch (error: any) {
        console.error('Send message error:', error.message);
        callback({ success: false, message: error.message });
      }
    });
  
    socket.on("get_chat_history", async ({ roomId }: { roomId: string }, callback: (response: CallbackResponse) => void) => {
      try {
        const game = await Game.findOne({ roomId }).populate('chat.sender', 'username');
        if (!game) throw new Error('بازی یافت نشد');
  
     
        interface ChatHistoryItem {
          sender: string;
          message: string;
          timestamp: Date;
        }
        
        const chatHistory: ChatHistoryItem[] = game.chat.map((msg: any) => ({
          sender: msg.sender.username,
          message: msg.message,
          timestamp: msg.timestamp
        }));
  
        callback({ success: true, chat: chatHistory });
      } catch (error: any) {
        console.error('Get chat history error:', error.message);
        callback({ success: false, message: error.message });
      }
    });
  
    socket.on("disconnect", async () => {
      console.log(`Client disconnected: ${socket.id}`);

      const queueIndex = matchmakingQueue.findIndex(p => p.socketId === socket.id);
      if (queueIndex !== -1) {
        matchmakingQueue.splice(queueIndex, 1);
      }

      for (const [roomId, room] of gameRooms.entries()) {
        if (room.players.has(socket.id)) {
          await handlePlayerLeaving(io, socket.id, roomId);
        }
      }
    });
  });

  setInterval(async () => {
    for (const [roomId, room] of gameRooms.entries()) {
      if (room.isEmpty() || room.isInactive(ROOM_CLEANUP_INTERVAL)) {
        room.clearTurnTimer();
        
        // Save any incomplete games
        if (room.gameState.gameStatus === "active" && room.gameState.lines.length > 0) {
          await room.saveGame();
        }
        
        gameRooms.delete(roomId);
      }
    }
  }, 60 * 1000);

  httpServer.listen(port, () => {
    console.log(`Server running on http://${hostname}:${port}`);
  });
});