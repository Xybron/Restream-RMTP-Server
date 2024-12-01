const NodeMediaServer = require('node-media-server');
const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Load stream config
const configPath = path.join(__dirname, 'config', 'stream-config.json');
let streamConfig = {};

try {
    const configData = fs.readFileSync(configPath, 'utf8');
    streamConfig = JSON.parse(configData);
} catch (error) {
    console.error('Error loading config:', error);
    // Initialize with default config if file doesn't exist
    streamConfig = {
        facebook: {
            enabled: false,
            rtmpUrl: "rtmps://live-api-s.facebook.com:443/rtmp/",
            streamKey: ""
        },
        youtube: {
            enabled: false,
            rtmpUrl: "rtmp://a.rtmp.youtube.com/live2/",
            streamKey: ""
        }
    };
}

// RTMP Server configuration
const config = {
    rtmp: {
        port: 1936,
        chunk_size: 60000,
        gop_cache: true,
        ping: 30,
        ping_timeout: 60
    },
    http: {
        port: 8001,
        allow_origin: '*',
        mediaroot: './media',
    },
    trans: {
        ffmpeg: '/opt/homebrew/bin/ffmpeg',
        tasks: [
            {
                app: 'live',
                hls: true,
                hlsFlags: '[hls_time=2:hls_list_size=3:hls_flags=delete_segments]',
                hlsKeep: true,
                dash: true,
                dashFlags: '[f=dash:window_size=3:extra_window_size=5]'
            }
        ]
    }
};

// Initialize RTMP server
const nms = new NodeMediaServer(config);

// Track active FFmpeg processes
const activeStreams = new Map();

// Function to start FFmpeg restream
function startRestream(inputUrl, outputUrl, platform) {
    // FFmpeg settings for bandwidth optimization
    const ffmpeg = spawn('/opt/homebrew/bin/ffmpeg', [
        '-i', inputUrl,
        // Buffer size and read rate
        '-bufsize', '6000k',
        '-maxrate', '4500k',
        // Video settings
        '-c:v', 'libx264',
        '-preset', 'veryfast',  // Faster encoding, less CPU
        '-g', '60',  // Keyframe interval
        '-r', '30',  // Frame rate
        '-b:v', '4000k',  // Video bitrate
        // Audio settings
        '-c:a', 'aac',
        '-b:a', '128k',  // Audio bitrate
        '-ar', '44100',  // Audio sample rate
        // Output format
        '-f', 'flv',
        // Minimize latency
        '-tune', 'zerolatency',
        outputUrl
    ]);

    console.log(`Started ${platform} restream process with optimized settings`);

    ffmpeg.stdout.on('data', (data) => {
        console.log(`${platform} FFmpeg stdout: ${data}`);
    });

    ffmpeg.stderr.on('data', (data) => {
        console.log(`${platform} FFmpeg stderr: ${data}`);
    });

    ffmpeg.on('close', (code) => {
        console.log(`${platform} FFmpeg process exited with code ${code}`);
        activeStreams.delete(platform);
    });

    ffmpeg.on('error', (error) => {
        console.error(`${platform} FFmpeg process error:`, error);
        activeStreams.delete(platform);
    });

    return ffmpeg;
}

// Handle stream start event for restreaming
nms.on('prePublish', async (id, StreamPath, args) => {
    console.log('[NodeEvent on prePublish]', {
        id,
        StreamPath,
        args
    });
    
    // Only handle streams in the 'live' app
    if (!StreamPath.startsWith('/live/')) {
        console.log('Ignoring non-live stream:', StreamPath);
        return;
    }

    const inputUrl = `rtmp://localhost:${config.rtmp.port}${StreamPath}`;
    console.log('Current stream config:', JSON.stringify(streamConfig, null, 2));
    
    // Add a small delay between starting streams to avoid bandwidth spike
    const startStreamWithDelay = async (platform, url, delay) => {
        await new Promise(resolve => setTimeout(resolve, delay));
        try {
            const ffmpeg = startRestream(inputUrl, url, platform);
            activeStreams.set(platform, ffmpeg);
            console.log(`Started restreaming to ${platform}:`, url);
        } catch (error) {
            console.error(`Failed to restream to ${platform}:`, error);
        }
    };

    // Start streams with a delay between them
    if (streamConfig.facebook.enabled && streamConfig.facebook.streamKey) {
        const facebookUrl = `${streamConfig.facebook.rtmpUrl}${streamConfig.facebook.streamKey}`;
        await startStreamWithDelay('facebook', facebookUrl, 0);
    } else {
        console.log('Facebook restreaming not configured or disabled');
    }

    if (streamConfig.youtube.enabled && streamConfig.youtube.streamKey) {
        const youtubeUrl = `${streamConfig.youtube.rtmpUrl}${streamConfig.youtube.streamKey}`;
        await startStreamWithDelay('youtube', youtubeUrl, 2000); // 2 second delay
    } else {
        console.log('YouTube restreaming not configured or disabled');
    }
});

// Handle stream end event
nms.on('donePublish', (id, StreamPath, args) => {
    console.log('[NodeEvent on donePublish]', {
        id,
        StreamPath,
        args
    });

    // Stop all active restreams
    for (const [platform, ffmpeg] of activeStreams.entries()) {
        console.log(`Stopping ${platform} restream`);
        ffmpeg.kill();
        activeStreams.delete(platform);
    }
});

// Add error event handler
nms.on('error', (err, id, StreamPath) => {
    console.error('[NodeEvent on error]', {
        error: err,
        id,
        StreamPath
    });
});

// Express app for web interface
const app = express();
const webPort = 3500;

// Add JSON body parser
app.use(express.json());

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Serve media files
app.use('/media', express.static(path.join(__dirname, 'media')));

// Stream configuration endpoint
app.get('/api/stream-config', (req, res) => {
    res.json({
        facebook: {
            enabled: streamConfig.facebook.enabled,
            status: streamConfig.facebook.enabled ? 'Connected' : 'Disabled'
        },
        youtube: {
            enabled: streamConfig.youtube.enabled,
            status: streamConfig.youtube.enabled ? 'Connected' : 'Disabled'
        }
    });
});

// Update stream configuration
app.post('/api/update-stream-config', (req, res) => {
    const { platform, streamKey } = req.body;
    
    if (!platform || !streamKey) {
        return res.status(400).json({ error: 'Missing platform or stream key' });
    }

    if (!['youtube', 'facebook'].includes(platform)) {
        return res.status(400).json({ error: 'Invalid platform' });
    }

    try {
        // Update config
        streamConfig[platform].streamKey = streamKey;
        streamConfig[platform].enabled = true;
        
        // Write to file
        fs.writeFileSync(configPath, JSON.stringify(streamConfig, null, 4));
        
        res.json({ success: true, message: 'Configuration updated successfully' });
    } catch (error) {
        console.error('Error updating configuration:', error);
        res.status(500).json({ error: 'Failed to update configuration' });
    }
});

// Basic status endpoint
app.get('/api/status', (req, res) => {
    res.json({
        status: 'running',
        rtmpUrl: 'rtmp://localhost:1936/live',
        streamKey: 'stream1'
    });
});

// Start both servers
Promise.all([
    new Promise(resolve => {
        app.listen(webPort, () => {
            console.log(`Web server running on http://localhost:${webPort}`);
            resolve();
        });
    }),
    new Promise(resolve => {
        nms.run();
        console.log(`RTMP server running on rtmp://localhost:${config.rtmp.port}`);
        resolve();
    })
]).then(() => {
    console.log('All servers started successfully');
});
