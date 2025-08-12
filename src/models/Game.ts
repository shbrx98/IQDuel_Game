import mongoose from 'mongoose';


const ChatMessageSchema = new mongoose.Schema({
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  message: { type: String, required: true },
  timestamp: { type: Date, default: Date.now }
}, { _id: false });


const GameSchema = new mongoose.Schema({
  roomId: { type: String, required: true, unique: true },
  startedAt: { type: Date, default: Date.now },
  endedAt: { type: Date },
  players: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    playerNumber: { type: Number, required: true },
    username: { type: String, required: true },
    phone: { type: String },
    ref: { type: String }
  }],
  gameState: {
    lines: [{
      start: { row: Number, col: Number },
      end: { row: Number, col: Number },
      player: Number,
      timestamp: { type: Date, default: Date.now }
    }],
    boxes: [{
      topLeft: { row: Number, col: Number },
      player: Number,
      id: String
    }],
    scores: {
      player1: { type: Number, default: 0 },
      player2: { type: Number, default: 0 }
    },
    winner: Number,
    duration: Number
  },
  chat: [ChatMessageSchema] 
});

export default mongoose.models.Game || mongoose.model('Game', GameSchema);