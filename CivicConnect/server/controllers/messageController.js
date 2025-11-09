import Message from '../models/Message.js';
import User from '../models/User.js';
import cloudinary from '../config/cloudinary.js';

// @desc    Send a message
// @route   POST /api/messages
// @access  Private
export const sendMessage = async (req, res) => {
  try {
    const { receiverId, content } = req.body;

    if (!content && !req.file) {
      return res.status(400).json({ message: 'Message content or media is required' });
    }

    const receiver = await User.findById(receiverId);

    if (!receiver) {
      return res.status(404).json({ message: 'Receiver not found' });
    }

    let media = null;

    // Upload media if present
    if (req.file) {
      const isVideo = req.file.mimetype.startsWith('video/');
      
      const result = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          { 
            folder: 'civicconnect/messages',
            resource_type: isVideo ? 'video' : 'image'
          },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        uploadStream.end(req.file.buffer);
      });

      media = {
        url: result.secure_url,
        type: isVideo ? 'video' : 'image',
        publicId: result.public_id
      };
    }

    const message = await Message.create({
      sender: req.user._id,
      receiver: receiverId,
      content: content || '',
      media
    });

    const populatedMessage = await Message.findById(message._id)
      .populate('sender', 'username fullName profilePicture')
      .populate('receiver', 'username fullName profilePicture');

    // Emit socket event to receiver
    const io = req.app.get('io');
    io.to(receiverId).emit('newMessage', populatedMessage);

    res.status(201).json(populatedMessage);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get conversation between two users
// @route   GET /api/messages/conversation/:userId
// @access  Private
export const getConversation = async (req, res) => {
  try {
    const messages = await Message.find({
      $or: [
        { sender: req.user._id, receiver: req.params.userId },
        { sender: req.params.userId, receiver: req.user._id }
      ]
    })
      .sort({ createdAt: 1 })
      .populate('sender', 'username fullName profilePicture')
      .populate('receiver', 'username fullName profilePicture');

    // Mark messages as read
    await Message.updateMany(
      { sender: req.params.userId, receiver: req.user._id, isRead: false },
      { isRead: true, readAt: Date.now() }
    );

    res.json(messages);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get all conversations
// @route   GET /api/messages/conversations
// @access  Private
export const getConversations = async (req, res) => {
  try {
    // Get all users that the current user has messaged with
    const messages = await Message.find({
      $or: [
        { sender: req.user._id },
        { receiver: req.user._id }
      ]
    })
      .sort({ createdAt: -1 })
      .populate('sender', 'username fullName profilePicture isOnline lastSeen')
      .populate('receiver', 'username fullName profilePicture isOnline lastSeen');

    // Group by conversation partner
    const conversationsMap = new Map();

    messages.forEach(message => {
      const partnerId = message.sender._id.toString() === req.user._id.toString()
        ? message.receiver._id.toString()
        : message.sender._id.toString();

      if (!conversationsMap.has(partnerId)) {
        const partner = message.sender._id.toString() === req.user._id.toString()
          ? message.receiver
          : message.sender;

        conversationsMap.set(partnerId, {
          partner,
          lastMessage: message,
          unreadCount: 0
        });
      }
    });

    // Get unread counts
    for (const [partnerId, conversation] of conversationsMap) {
      const unreadCount = await Message.countDocuments({
        sender: partnerId,
        receiver: req.user._id,
        isRead: false
      });
      conversation.unreadCount = unreadCount;
    }

    const conversations = Array.from(conversationsMap.values());

    res.json(conversations);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Delete message
// @route   DELETE /api/messages/:id
// @access  Private
export const deleteMessage = async (req, res) => {
  try {
    const message = await Message.findById(req.params.id);

    if (!message) {
      return res.status(404).json({ message: 'Message not found' });
    }

    if (message.sender.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to delete this message' });
    }

    // Delete media from cloudinary if exists
    if (message.media && message.media.publicId) {
      await cloudinary.uploader.destroy(message.media.publicId, {
        resource_type: message.media.type === 'video' ? 'video' : 'image'
      });
    }

    await message.deleteOne();

    res.json({ message: 'Message deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Mark messages as read
// @route   PUT /api/messages/read/:userId
// @access  Private
export const markAsRead = async (req, res) => {
  try {
    await Message.updateMany(
      { sender: req.params.userId, receiver: req.user._id, isRead: false },
      { isRead: true, readAt: Date.now() }
    );

    res.json({ message: 'Messages marked as read' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
