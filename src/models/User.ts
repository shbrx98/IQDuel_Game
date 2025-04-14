import mongoose from 'mongoose';

const StatisticsSchema = new mongoose.Schema({
  totalGames: { type: Number, default: 0 },
  wins: { type: Number, default: 0 },
  losses: { type: Number, default: 0 },
  draws: { type: Number, default: 0 },
  totalScore: { type: Number, default: 0 }
}, { _id: false });

const UserSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  username: { type: String, required: true },
  ref: { type: String },
  rol:{type: String ,default:"player"},
  createdAt: { type: Date, default: Date.now },
  lastLogin: { type: Date, default: Date.now },
  statistics: { type: StatisticsSchema, default: () => ({}) }
});

export default mongoose.models.User || mongoose.model('User', UserSchema);