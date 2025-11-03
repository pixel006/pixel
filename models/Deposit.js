const mongoose = require('mongoose');

const depositSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  principal: Number,              // изначальная сумма
  accrued: { type: Number, default: 0 }, // накопленные проценты
  startDate: { type: Date, default: Date.now },
  lastInterestDate: { type: Date, default: Date.now },
  status: { type: String, enum: ['active', 'completed'], default: 'active' }
});

module.exports = mongoose.model('Deposit', depositSchema);