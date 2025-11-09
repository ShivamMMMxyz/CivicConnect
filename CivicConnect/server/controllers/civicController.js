import CivicActivity from '../models/CivicActivity.js';
import User from '../models/User.js';
import Notification from '../models/Notification.js';
import cloudinary from '../config/cloudinary.js';

// @desc    Submit civic activity
// @route   POST /api/civic/activities
// @access  Private
export const submitActivity = async (req, res) => {
  try {
    const { title, description, category, location, date, hours } = req.body;

    if (!title || !description || !category || !date) {
      return res.status(400).json({ message: 'Please provide all required fields' });
    }

    const proof = [];

    // Upload proof files if present
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const isVideo = file.mimetype.startsWith('video/');
        
        const result = await new Promise((resolve, reject) => {
          const uploadStream = cloudinary.uploader.upload_stream(
            { 
              folder: 'civicconnect/civic-activities',
              resource_type: isVideo ? 'video' : 'image'
            },
            (error, result) => {
              if (error) reject(error);
              else resolve(result);
            }
          );
          uploadStream.end(file.buffer);
        });

        proof.push({
          url: result.secure_url,
          type: isVideo ? 'video' : 'image',
          publicId: result.public_id
        });
      }
    }

    const activity = await CivicActivity.create({
      user: req.user._id,
      title,
      description,
      category,
      location: location || '',
      date,
      hours: hours || 0,
      proof,
      status: 'pending'
    });

    const populatedActivity = await CivicActivity.findById(activity._id)
      .populate('user', 'username fullName profilePicture civicPoints civicRank');

    res.status(201).json(populatedActivity);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get all civic activities (with filters)
// @route   GET /api/civic/activities
// @access  Public
export const getActivities = async (req, res) => {
  try {
    const { status, category, userId } = req.query;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    let query = {};

    if (status) query.status = status;
    if (category) query.category = category;
    if (userId) query.user = userId;

    // Only show approved activities to non-admins
    if (!req.user || !req.user.isAdmin) {
      query.status = 'approved';
    }

    const activities = await CivicActivity.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('user', 'username fullName profilePicture civicPoints civicRank')
      .populate('verifiedBy', 'username fullName');

    const total = await CivicActivity.countDocuments(query);

    res.json({
      activities,
      currentPage: page,
      totalPages: Math.ceil(total / limit),
      total
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get single civic activity
// @route   GET /api/civic/activities/:id
// @access  Public
export const getActivity = async (req, res) => {
  try {
    const activity = await CivicActivity.findById(req.params.id)
      .populate('user', 'username fullName profilePicture civicPoints civicRank')
      .populate('verifiedBy', 'username fullName')
      .populate('endorsements.user', 'username fullName profilePicture');

    if (!activity) {
      return res.status(404).json({ message: 'Activity not found' });
    }

    res.json(activity);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Approve civic activity (Admin only)
// @route   PUT /api/civic/activities/:id/approve
// @access  Private/Admin
export const approveActivity = async (req, res) => {
  try {
    const activity = await CivicActivity.findById(req.params.id);

    if (!activity) {
      return res.status(404).json({ message: 'Activity not found' });
    }

    if (activity.status !== 'pending') {
      return res.status(400).json({ message: 'Activity already processed' });
    }

    const pointsToAward = parseInt(process.env.POINTS_PER_GOOD_DEED) || 100;

    activity.status = 'approved';
    activity.pointsAwarded = pointsToAward;
    activity.verifiedBy = req.user._id;
    activity.verifiedAt = Date.now();

    await activity.save();

    // Update user's civic points
    const user = await User.findById(activity.user);
    user.civicPoints += pointsToAward;
    user.updateCivicRank();
    await user.save();

    // Create notification
    await Notification.create({
      recipient: user._id,
      type: 'civic-approved',
      civicActivity: activity._id,
      message: `Your civic activity "${activity.title}" has been approved! You earned ${pointsToAward} Civic Points.`
    });

    // Emit socket event
    const io = req.app.get('io');
    io.to(user._id.toString()).emit('notification', {
      type: 'civic-approved',
      civicActivity: activity._id,
      pointsAwarded: pointsToAward
    });

    res.json({ message: 'Activity approved successfully', activity });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Reject civic activity (Admin only)
// @route   PUT /api/civic/activities/:id/reject
// @access  Private/Admin
export const rejectActivity = async (req, res) => {
  try {
    const { reason } = req.body;
    const activity = await CivicActivity.findById(req.params.id);

    if (!activity) {
      return res.status(404).json({ message: 'Activity not found' });
    }

    if (activity.status !== 'pending') {
      return res.status(400).json({ message: 'Activity already processed' });
    }

    activity.status = 'rejected';
    activity.rejectionReason = reason || 'Does not meet criteria';
    activity.verifiedBy = req.user._id;
    activity.verifiedAt = Date.now();

    await activity.save();

    // Create notification
    await Notification.create({
      recipient: activity.user,
      type: 'civic-rejected',
      civicActivity: activity._id,
      message: `Your civic activity "${activity.title}" was not approved. Reason: ${activity.rejectionReason}`
    });

    // Emit socket event
    const io = req.app.get('io');
    io.to(activity.user.toString()).emit('notification', {
      type: 'civic-rejected',
      civicActivity: activity._id,
      reason: activity.rejectionReason
    });

    res.json({ message: 'Activity rejected', activity });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Endorse civic activity
// @route   POST /api/civic/activities/:id/endorse
// @access  Private
export const endorseActivity = async (req, res) => {
  try {
    const { message } = req.body;
    const activity = await CivicActivity.findById(req.params.id);

    if (!activity) {
      return res.status(404).json({ message: 'Activity not found' });
    }

    if (activity.status !== 'approved') {
      return res.status(400).json({ message: 'Can only endorse approved activities' });
    }

    if (activity.user.toString() === req.user._id.toString()) {
      return res.status(400).json({ message: 'Cannot endorse your own activity' });
    }

    // Check if already endorsed
    const alreadyEndorsed = activity.endorsements.some(
      e => e.user.toString() === req.user._id.toString()
    );

    if (alreadyEndorsed) {
      return res.status(400).json({ message: 'Already endorsed this activity' });
    }

    const endorsementPoints = parseInt(process.env.POINTS_PER_ENDORSEMENT) || 10;

    activity.endorsements.push({
      user: req.user._id,
      message: message || '',
      pointsGiven: endorsementPoints
    });

    await activity.save();

    // Update user's civic points
    const user = await User.findById(activity.user);
    user.civicPoints += endorsementPoints;
    user.updateCivicRank();
    await user.save();

    // Create notification
    await Notification.create({
      recipient: user._id,
      sender: req.user._id,
      type: 'endorsement',
      civicActivity: activity._id,
      message: `${req.user.fullName} endorsed your civic activity!`
    });

    // Emit socket event
    const io = req.app.get('io');
    io.to(user._id.toString()).emit('notification', {
      type: 'endorsement',
      sender: {
        _id: req.user._id,
        username: req.user.username,
        fullName: req.user.fullName,
        profilePicture: req.user.profilePicture
      },
      civicActivity: activity._id,
      pointsAwarded: endorsementPoints
    });

    res.json({ message: 'Activity endorsed successfully', activity });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get civic leaderboard
// @route   GET /api/civic/leaderboard
// @access  Public
export const getLeaderboard = async (req, res) => {
  try {
    const period = req.query.period || 'all-time'; // all-time, month, week
    const limit = parseInt(req.query.limit) || 50;

    let dateFilter = {};
    if (period === 'month') {
      const lastMonth = new Date();
      lastMonth.setMonth(lastMonth.getMonth() - 1);
      dateFilter.createdAt = { $gte: lastMonth };
    } else if (period === 'week') {
      const lastWeek = new Date();
      lastWeek.setDate(lastWeek.getDate() - 7);
      dateFilter.createdAt = { $gte: lastWeek };
    }

    const users = await User.find()
      .sort({ civicPoints: -1 })
      .limit(limit)
      .select('username fullName profilePicture civicPoints civicRank isVerified');

    res.json(users);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get user's civic stats
// @route   GET /api/civic/stats/:userId
// @access  Public
export const getUserCivicStats = async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const totalActivities = await CivicActivity.countDocuments({ 
      user: user._id, 
      status: 'approved' 
    });

    const pendingActivities = await CivicActivity.countDocuments({ 
      user: user._id, 
      status: 'pending' 
    });

    const totalEndorsements = await CivicActivity.aggregate([
      { $match: { user: user._id, status: 'approved' } },
      { $project: { endorsementCount: { $size: '$endorsements' } } },
      { $group: { _id: null, total: { $sum: '$endorsementCount' } } }
    ]);

    res.json({
      civicPoints: user.civicPoints,
      civicRank: user.civicRank,
      totalActivities,
      pendingActivities,
      totalEndorsements: totalEndorsements[0]?.total || 0
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
