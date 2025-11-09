import Post from '../models/Post.js';
import Comment from '../models/Comment.js';
import Notification from '../models/Notification.js';
import User from '../models/User.js';
import cloudinary from '../config/cloudinary.js';

// @desc    Create a new post
// @route   POST /api/posts
// @access  Private
export const createPost = async (req, res) => {
  try {
    const { content, visibility } = req.body;

    if (!content && (!req.files || req.files.length === 0)) {
      return res.status(400).json({ message: 'Post must have content or media' });
    }

    const media = [];

    // Upload media files to cloudinary if present
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const isVideo = file.mimetype.startsWith('video/');
        
        const result = await new Promise((resolve, reject) => {
          const uploadStream = cloudinary.uploader.upload_stream(
            { 
              folder: 'civicconnect/posts',
              resource_type: isVideo ? 'video' : 'image'
            },
            (error, result) => {
              if (error) reject(error);
              else resolve(result);
            }
          );
          uploadStream.end(file.buffer);
        });

        media.push({
          url: result.secure_url,
          type: isVideo ? 'video' : 'image',
          publicId: result.public_id
        });
      }
    }

    const post = await Post.create({
      author: req.user._id,
      content: content || '',
      media,
      visibility: visibility || 'public'
    });

    const populatedPost = await Post.findById(post._id)
      .populate('author', 'username fullName profilePicture civicRank');

    res.status(201).json(populatedPost);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get all posts (feed)
// @route   GET /api/posts
// @access  Public
export const getPosts = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    let query = { visibility: 'public' };

    // If user is authenticated, show posts from followed users
    if (req.user) {
      const user = await User.findById(req.user._id);
      query = {
        $or: [
          { visibility: 'public' },
          { author: { $in: user.following }, visibility: 'followers' },
          { author: req.user._id }
        ]
      };
    }

    const posts = await Post.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('author', 'username fullName profilePicture civicRank isVerified')
      .populate({
        path: 'comments',
        options: { limit: 3, sort: { createdAt: -1 } },
        populate: { path: 'author', select: 'username fullName profilePicture' }
      });

    const total = await Post.countDocuments(query);

    res.json({
      posts,
      currentPage: page,
      totalPages: Math.ceil(total / limit),
      total
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get single post
// @route   GET /api/posts/:id
// @access  Public
export const getPost = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id)
      .populate('author', 'username fullName profilePicture civicRank isVerified')
      .populate({
        path: 'comments',
        populate: { path: 'author', select: 'username fullName profilePicture' }
      });

    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    res.json(post);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update post
// @route   PUT /api/posts/:id
// @access  Private
export const updatePost = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    // Check if user is the author
    if (post.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to update this post' });
    }

    post.content = req.body.content || post.content;
    post.visibility = req.body.visibility || post.visibility;
    post.isEdited = true;
    post.editedAt = Date.now();

    const updatedPost = await post.save();
    await updatedPost.populate('author', 'username fullName profilePicture civicRank');

    res.json(updatedPost);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Delete post
// @route   DELETE /api/posts/:id
// @access  Private
export const deletePost = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    // Check if user is the author or admin
    if (post.author.toString() !== req.user._id.toString() && !req.user.isAdmin) {
      return res.status(403).json({ message: 'Not authorized to delete this post' });
    }

    // Delete media from cloudinary
    if (post.media && post.media.length > 0) {
      for (const item of post.media) {
        if (item.publicId) {
          await cloudinary.uploader.destroy(item.publicId, {
            resource_type: item.type === 'video' ? 'video' : 'image'
          });
        }
      }
    }

    // Delete all comments
    await Comment.deleteMany({ post: post._id });

    await post.deleteOne();

    res.json({ message: 'Post deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Like/Unlike post
// @route   PUT /api/posts/:id/like
// @access  Private
export const likePost = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    const isLiked = post.likes.includes(req.user._id);

    if (isLiked) {
      // Unlike
      post.likes = post.likes.filter(id => id.toString() !== req.user._id.toString());
    } else {
      // Like
      post.likes.push(req.user._id);

      // Create notification if not own post
      if (post.author.toString() !== req.user._id.toString()) {
        await Notification.create({
          recipient: post.author,
          sender: req.user._id,
          type: 'like',
          post: post._id
        });

        // Emit socket event
        const io = req.app.get('io');
        io.to(post.author.toString()).emit('notification', {
          type: 'like',
          sender: {
            _id: req.user._id,
            username: req.user.username,
            fullName: req.user.fullName,
            profilePicture: req.user.profilePicture
          },
          post: post._id
        });
      }
    }

    await post.save();

    res.json({ likes: post.likes.length, isLiked: !isLiked });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Share post
// @route   POST /api/posts/:id/share
// @access  Private
export const sharePost = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    // Check if already shared
    const alreadyShared = post.shares.some(
      share => share.user.toString() === req.user._id.toString()
    );

    if (alreadyShared) {
      return res.status(400).json({ message: 'Post already shared' });
    }

    post.shares.push({ user: req.user._id });
    await post.save();

    // Create notification
    if (post.author.toString() !== req.user._id.toString()) {
      await Notification.create({
        recipient: post.author,
        sender: req.user._id,
        type: 'share',
        post: post._id
      });

      // Emit socket event
      const io = req.app.get('io');
      io.to(post.author.toString()).emit('notification', {
        type: 'share',
        sender: {
          _id: req.user._id,
          username: req.user.username,
          fullName: req.user.fullName,
          profilePicture: req.user.profilePicture
        },
        post: post._id
      });
    }

    res.json({ message: 'Post shared successfully', shares: post.shares.length });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get user's posts
// @route   GET /api/posts/user/:userId
// @access  Public
export const getUserPosts = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const posts = await Post.find({ author: req.params.userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('author', 'username fullName profilePicture civicRank isVerified');

    const total = await Post.countDocuments({ author: req.params.userId });

    res.json({
      posts,
      currentPage: page,
      totalPages: Math.ceil(total / limit),
      total
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
