import mongoose from 'mongoose';

const civicActivitySchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  title: {
    type: String,
    required: [true, 'Activity title is required'],
    maxlength: 200
  },
  description: {
    type: String,
    required: [true, 'Activity description is required'],
    maxlength: 2000
  },
  category: {
    type: String,
    enum: ['community-service', 'environmental', 'education', 'healthcare', 'animal-welfare', 'disaster-relief', 'other'],
    required: true
  },
  proof: [{
    url: String,
    type: {
      type: String,
      enum: ['image', 'video']
    },
    publicId: String
  }],
  location: {
    type: String,
    default: ''
  },
  date: {
    type: Date,
    required: true
  },
  hours: {
    type: Number,
    min: 0,
    default: 0
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  pointsAwarded: {
    type: Number,
    default: 0
  },
  verifiedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  verifiedAt: {
    type: Date
  },
  rejectionReason: {
    type: String,
    maxlength: 500
  },
  endorsements: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    message: {
      type: String,
      maxlength: 500
    },
    pointsGiven: {
      type: Number,
      default: 10
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  }]
}, {
  timestamps: true
});

// Index for faster queries
civicActivitySchema.index({ user: 1, createdAt: -1 });
civicActivitySchema.index({ status: 1, createdAt: -1 });

const CivicActivity = mongoose.model('CivicActivity', civicActivitySchema);

export default CivicActivity;
