require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const sharp = require('sharp'); 
const ffmpeg = require('fluent-ffmpeg'); 
const ffmpegStatic = require('ffmpeg-static');

// Memberitahu fluent-ffmpeg di mana letak program FFmpeg berada
ffmpeg.setFfmpegPath(ffmpegStatic);

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
})); 
app.use(express.json()); 

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

const tempDir = path.join(__dirname, 'temp_media');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

if (!supabaseUrl || !supabaseKey) {
    console.error("=====================================================");
    console.error("❌ CRITICAL ERROR: Kredensial Supabase Tidak Ditemukan!");
    console.error("=====================================================");
    process.exit(1); 
}

const getAuthClient = (req) => {
    const authHeader = req.headers.authorization;
    return createClient(supabaseUrl, supabaseKey, {
        global: {
            headers: authHeader ? { Authorization: authHeader } : {}
        }
    });
};

// ==========================================
// ROUTE DEFAULT (ROOT)
// ==========================================
app.get('/', (req, res) => {
    res.json({ 
        status: "success", 
        message: "✅ Belini Backend API berjalan dengan lancar di Cloud!",
        version: "1.0.3 (Standard Cloud Version)"
    });
});

// ==========================================
// FUNGSI PEMBANTU: MEDIA PROCESSING
// ==========================================

async function createTextPng(text, color, sizeLabel) {
    const sizeMap = { 'small': 40, 'medium': 60, 'large': 90 };
    const fontSize = sizeMap[sizeLabel] || 60;
    
    const svgText = `
    <svg width="1000" height="200">
      <style>
        .title { fill: ${color}; font-size: ${fontSize}px; font-weight: bold; font-family: sans-serif; filter: drop-shadow(3px 3px 4px rgba(0,0,0,0.8)); }
      </style>
      <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" class="title">${text}</text>
    </svg>`;
    
    return await sharp(Buffer.from(svgText)).png().toBuffer();
}

async function processImageWithText(imageUrl, text, color = 'white', sizeLabel = 'medium', position = 'bottom') {
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const inputBuffer = Buffer.from(response.data, 'binary');

    const sizeMap = { 'small': 40, 'medium': 60, 'large': 90 };
    const posMap = { 'top': '15%', 'center': '50%', 'bottom': '85%' };

    const fontSize = sizeMap[sizeLabel] || 60;
    const yPos = posMap[position] || '85%';

    const svgText = `
    <svg width="1080" height="1080">
      <style>
        .title { fill: ${color}; font-size: ${fontSize}px; font-weight: bold; font-family: sans-serif; filter: drop-shadow(4px 4px 6px rgba(0,0,0,0.7)); }
      </style>
      <text x="50%" y="${yPos}" text-anchor="middle" class="title">${text}</text>
    </svg>`;

    return await sharp(inputBuffer)
        .resize(1080, 1080, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 1 } })
        .composite([{ input: Buffer.from(svgText), top: 0, left: 0 }])
        .jpeg({ quality: 90 })
        .toBuffer();
}

async function processVideo(videoUrl, options) {
    const outputName = `edit_${uuidv4()}.mp4`;
    const outputPath = path.join(tempDir, outputName);
    let tempTextPath = null;

    return new Promise(async (resolve, reject) => {
        try {
            let command = ffmpeg().input(videoUrl);
            let outputOptions = [];
            let filterIndex = 1; 

            if (options.overlayText) {
                tempTextPath = path.join(tempDir, `text_${uuidv4()}.png`);
                const textPngBuffer = await createTextPng(options.overlayText, options.textColor || 'white', options.textSize || 'medium');
                fs.writeFileSync(tempTextPath, textPngBuffer);

                command = command.input(tempTextPath);
                const videoInputIndex = filterIndex++;

                const posMap = { 'top': '(H-h)*0.15', 'center': '(H-h)/2', 'bottom': '(H-h)*0.85' };
                const yPos = posMap[options.textPosition] || '(H-h)*0.85';

                command = command.complexFilter([
                    `[0:v][${videoInputIndex}:v]overlay=(W-w)/2:${yPos}[video_final]`
                ]);
                outputOptions.push('-map [video_final]');
                outputOptions.push('-c:v libx264'); 
                outputOptions.push('-preset ultrafast');
            } else {
                outputOptions.push('-map 0:v:0');
                outputOptions.push('-c:v copy'); 
            }

            if (options.musicUrl) {
                command = command.input(options.musicUrl);
                const audioInputIndex = filterIndex++;
                outputOptions.push(`-map ${audioInputIndex}:a:0`);
                outputOptions.push('-c:a aac'); 
            } else {
                outputOptions.push('-map 0:a?'); 
                outputOptions.push('-c:a copy');
            }

            outputOptions.push('-shortest'); 

            command
                .outputOptions(outputOptions)
                .save(outputPath)
                .on('end', () => {
                    if (tempTextPath && fs.existsSync(tempTextPath)) fs.unlinkSync(tempTextPath);
                    resolve(outputPath);
                })
                .on('error', (err) => {
                    if (tempTextPath && fs.existsSync(tempTextPath)) fs.unlinkSync(tempTextPath);
                    reject(new Error(`Gagal memproses video: ${err.message}`));
                });

        } catch (err) {
            reject(err);
        }
    });
}

// ==========================================
// API ROUTES: PRODUK & IG AKUN
// ==========================================

app.get('/api/products', async (req, res) => {
    const supabase = getAuthClient(req);
    const { data, error } = await supabase.from('products').select('*').order('id', { ascending: false });
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
});

app.post('/api/products', async (req, res) => {
    const supabase = getAuthClient(req);
    const { data, error } = await supabase.from('products').insert([req.body]).select();
    if (error) return res.status(401).json({ error: error.message });
    res.status(201).json({ success: true, data });
});

app.put('/api/products/:id', async (req, res) => {
    const supabase = getAuthClient(req);
    const { data, error } = await supabase.from('products').update(req.body).eq('id', req.params.id).select();
    if (error) return res.status(401).json({ error: error.message });
    res.json({ success: true, data });
});

app.delete('/api/products/:id', async (req, res) => {
    const supabase = getAuthClient(req);
    const { error } = await supabase.from('products').delete().eq('id', req.params.id);
    if (error) return res.status(401).json({ error: error.message });
    res.json({ success: true, message: 'Terhapus' });
});

app.post('/api/ig/add', async (req, res) => {
    const supabase = getAuthClient(req);
    const { label, ig_account_id, access_token } = req.body;
    try {
        const fbRes = await axios.get(`https://graph.facebook.com/v20.0/${ig_account_id}?access_token=${access_token}&fields=name,username`);
        const { data: { user } } = await supabase.auth.getUser();

        const { error } = await supabase.from('ig_accounts').insert([{
            label, ig_account_id, access_token, account_name: fbRes.data.name || fbRes.data.username || ig_account_id, user_id: user.id
        }]);

        if (error) throw error;
        res.json({ success: true, account_name: fbRes.data.name });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/ig/accounts', async (req, res) => {
    const supabase = getAuthClient(req);
    const { data, error } = await supabase.from('ig_accounts').select('id, label, ig_account_id, account_name');
    if (error) return res.status(401).json({ error: error.message });
    res.json(data);
});

app.delete('/api/ig/accounts/:id', async (req, res) => {
    const supabase = getAuthClient(req);
    const { error } = await supabase.from('ig_accounts').delete().eq('id', req.params.id);
    if (error) return res.status(401).json({ error: error.message });
    res.json({ success: true, message: 'Akun IG berhasil dilepas' });
});

// ==========================================
// API ROUTES: AI GENERATION PROXY
// ==========================================
app.post('/api/ai/generate', async (req, res) => {
    const supabase = getAuthClient(req);
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return res.status(401).json({ error: "Akses Ditolak. Sesi tidak valid." });

    const { provider, apiKey, promptContext, model } = req.body;

    if (!provider || !apiKey) {
        return res.status(400).json({ error: "Provider AI dan API Key wajib diisi." });
    }

    try {
        if (provider === 'gemini') {
            const modelName = model || 'gemini-2.5-flash';
            const aiRes = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`, {
                contents: [{ parts: [{ text: promptContext }] }]
            });
            return res.json({ success: true, caption: aiRes.data.candidates[0].content.parts[0].text });
            
        } else if (provider === 'chutes') {
            const modelName = model || "unsloth/Mistral-Nemo-Instruct-2407";
            const aiRes = await axios.post(`https://llm.chutes.ai/v1/chat/completions`, {
                model: modelName, messages: [{ role: "user", content: promptContext }], stream: false, max_tokens: 1024, temperature: 0.7
            }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } });
            return res.json({ success: true, caption: aiRes.data.choices[0].message.content });
            
        } else if (provider === 'groq') {
            const modelName = model || "openai/gpt-oss-120b";
            const aiRes = await axios.post(`https://api.groq.com/openai/v1/chat/completions`, {
                model: modelName, messages: [{ role: "user", content: promptContext }], stream: false, max_completion_tokens: 8192, temperature: 1, top_p: 1
            }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } });
            return res.json({ success: true, caption: aiRes.data.choices[0].message.content });
            
        } else if (provider === 'openrouter') {
            const modelName = model || "nvidia/nemotron-3-nano-30b-a3b:free";
            const aiRes = await axios.post(`https://openrouter.ai/api/v1/chat/completions`, {
                model: modelName, messages: [{ role: "user", content: promptContext }], stream: false
            }, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://belini.my.id', 'X-Title': 'Belini Admin Dashboard' } });
            return res.json({ success: true, caption: aiRes.data.choices[0].message.content });
        } else {
            return res.status(400).json({ error: "Provider AI tidak didukung." });
        }
    } catch (error) {
        const errorMsg = error.response?.data?.error?.message || error.response?.data?.detail || error.message;
        return res.status(500).json({ error: errorMsg });
    }
});

// ==========================================
// API ROUTES: AUTO POST DENGAN RETRY SYSTEM
// ==========================================

app.post('/api/ig/post', async (req, res) => {
    const supabase = getAuthClient(req);
    const { account_ids, image_url, caption, is_video, overlay_text, music_url, text_color, text_size, text_position } = req.body;

    try {
        const { data: accounts } = await supabase.from('ig_accounts').select('*').in('id', account_ids);
        if (!accounts || accounts.length === 0) throw new Error("Akun IG tidak ditemukan.");

        let finalMediaUrl = image_url;

        if (!is_video && overlay_text) {
            const buffer = await processImageWithText(image_url, overlay_text, text_color, text_size, text_position);
            const fileName = `edit_${Date.now()}.jpg`;
            const { error: upErr } = await supabase.storage.from('public-assets').upload(fileName, buffer, { contentType: 'image/jpeg' });
            if (upErr) throw upErr;
            finalMediaUrl = supabase.storage.from('public-assets').getPublicUrl(fileName).data.publicUrl;
        }
        
        if (is_video && (overlay_text || music_url)) {
            try {
                const processedVideoPath = await processVideo(image_url, {
                    musicUrl: music_url, overlayText: overlay_text, textColor: text_color, textSize: text_size, textPosition: text_position
                });
                
                const videoBuffer = fs.readFileSync(processedVideoPath);
                const fileName = `edit_vid_${Date.now()}.mp4`;
                const { error: upErr } = await supabase.storage.from('public-assets').upload(fileName, videoBuffer, { contentType: 'video/mp4' });
                if (fs.existsSync(processedVideoPath)) fs.unlinkSync(processedVideoPath); 
                if (upErr) throw upErr;
                finalMediaUrl = supabase.storage.from('public-assets').getPublicUrl(fileName).data.publicUrl;
            } catch (mediaErr) {
                throw new Error(mediaErr.message); 
            }
        }

        let successCount = 0;
        let errors = [];

        for (let acc of accounts) {
            try {
                let creationId;
                try {
                    const typeParam = is_video ? `media_type=REELS&video_url=` : `image_url=`;
                    const createRes = await axios.post(`https://graph.facebook.com/v20.0/${acc.ig_account_id}/media?${typeParam}${encodeURIComponent(finalMediaUrl)}&caption=${encodeURIComponent(caption)}&access_token=${acc.access_token}`);
                    creationId = createRes.data.id;
                } catch(err) {
                    throw new Error(`Upload Awal Gagal: ${err.response?.data?.error?.message || err.message}`);
                }

                if (!creationId) throw new Error("Gagal mendapatkan Creation ID dari Meta.");

                let isPublished = false;
                let lastPublishError = null;

                for (let attempt = 0; attempt < 10; attempt++) { 
                    await new Promise(r => setTimeout(r, 5000)); 
                    try {
                        const statusRes = await axios.get(`https://graph.facebook.com/v20.0/${creationId}?fields=status_code,status&access_token=${acc.access_token}`);
                        const statusCode = statusRes.data.status_code;
                        if (statusCode === 'ERROR' || statusCode === 'EXPIRED') {
                            throw new Error(`Meta gagal memproses media. Status: ${statusRes.data.status || statusCode}`);
                        }
                        if (statusCode === 'IN_PROGRESS') continue; 
                    } catch (statErr) {
                        if (statErr.message.includes('Meta gagal memproses media')) throw statErr;
                    }

                    try {
                        await axios.post(`https://graph.facebook.com/v20.0/${acc.ig_account_id}/media_publish?creation_id=${creationId}&access_token=${acc.access_token}`);
                        isPublished = true;
                        break; 
                    } catch (pubErr) {
                        lastPublishError = pubErr;
                        const errorCode = pubErr.response?.data?.error?.code;
                        const errorSubCode = pubErr.response?.data?.error?.error_subcode;
                        const errorMsg = pubErr.response?.data?.error?.message || "";
                        if (errorCode === 9007 || errorSubCode === 2207027 || errorMsg.includes("Media ID is not available")) {
                            continue; 
                        } else {
                            throw new Error(errorMsg || "Gagal mempublish media.");
                        }
                    }
                }

                if (!isPublished) throw new Error(lastPublishError?.response?.data?.error?.message || "Waktu tunggu habis.");
                successCount++;

            } catch (e) { 
                errors.push(`Gagal di akun ${acc.label}: ${e.message}`);
            }
        }

        res.json({ success: true, posted: successCount, failed: errors.length, messages: errors });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// START SERVER
// ==========================================
// PORT otomatis menyesuaikan lingkungan server cloud
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`✅ Backend API Belini berjalan di port ${PORT}`);
});