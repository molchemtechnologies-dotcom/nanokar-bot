// server.js - Express.js Backend API
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs').promises;

const app = express();
app.use(cors());
app.use(express.json());

// API Anahtarlarınız (Çevre değişkenlerinde tutun!)
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Ürün veritabanınızı buradan çekin
async function loadProductData() {
  // Option 1: JSON dosyasından
  const products = await fs.readFile('./products.json', 'utf8');
  return JSON.parse(products);
  
  // Option 2: Veritabanından
  // return await db.query('SELECT * FROM products');
  
  // Option 3: E-ticaret platformunuzdan API ile
  // return await fetch('https://nanokar.com.tr/api/products').then(r => r.json());
}

// Google Drive entegrasyonu
async function loadFromGoogleDrive() {
  // Google Drive API kullanarak dökümanları çekin
  // npm install googleapis
  const { google } = require('googleapis');
  // ... Google Drive auth ve dosya okuma
}

// Web scraping ile site içeriğini çek
async function scrapeWebsiteContent() {
  // Puppeteer veya Cheerio ile sitenizi tarayın
  const puppeteer = require('puppeteer');
  // ... scraping logic
}

// Bilgi tabanı oluşturma
async function buildKnowledgeBase() {
  const products = await loadProductData();
  
  return `
# Nanokar E-Ticaret Bilgi Tabanı

## Şirket Bilgileri
- İsim: Nanokar
- Web: nanokar.com.tr
- Alan: Nanoteknoloji Çözümleri
- Ürün Kategorileri: Metal Tozları, Nano Tozlar, Grafen, Seramik Tozlar

## Ürünler
${products.map(p => `
### ${p.name}
- Fiyat: ${p.price} TL
- Saflık: ${p.purity}
- Kullanım Alanları: ${p.usage}
- Stok: ${p.stock ? 'Mevcut' : 'Tükendi'}
- Açıklama: ${p.description}
`).join('\n')}

## SSS
1. Kargo ücretsiz mi? 
   - 500 TL üzeri siparişlerde kargo ücretsizdir.

2. Teslimat süresi nedir?
   - 2-3 iş günü içinde kargoya verilir.

3. Teknik destek var mı?
   - Evet, ürün kullanımı için teknik destek sağlıyoruz.
`;
}

// Claude API endpoint
app.post('/api/chat/claude', async (req, res) => {
  try {
    const { messages, userContext } = req.body;
    
    // Bilgi tabanını yükle
    const knowledgeBase = await buildKnowledgeBase();
    
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system: `Sen Nanokar'ın AI müşteri hizmetleri asistanısın. 

${knowledgeBase}

Görevlerin:
1. Ürün önerileri yap
2. Teknik sorulara cevap ver
3. Sipariş takibi yap
4. Fiyat ve stok bilgisi ver
5. Profesyonel ve yardımsever ol
6. SADECE bilgi tabanındaki bilgileri kullan
7. Bilmediğin şeyleri icat etme

Kullanıcı Bilgileri: ${JSON.stringify(userContext || {})}`,
        messages: messages
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01'
        }
      }
    );

    res.json({
      success: true,
      message: response.data.content[0].text,
      usage: response.data.usage
    });
  } catch (error) {
    console.error('Claude API Error:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: 'AI servisinde bir hata oluştu'
    });
  }
});

// OpenAI endpoint (alternatif)
app.post('/api/chat/openai', async (req, res) => {
  try {
    const { messages } = req.body;
    const knowledgeBase = await buildKnowledgeBase();
    
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4-turbo-preview',
        messages: [
          {
            role: 'system',
            content: `Sen Nanokar'ın AI asistanısın.\n\n${knowledgeBase}`
          },
          ...messages
        ],
        temperature: 0.7,
        max_tokens: 1000
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`
        }
      }
    );

    res.json({
      success: true,
      message: response.data.choices[0].message.content
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Gemini endpoint (alternatif)
app.post('/api/chat/gemini', async (req, res) => {
  try {
    const { messages } = req.body;
    const knowledgeBase = await buildKnowledgeBase();
    
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: messages.map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }]
        })),
        systemInstruction: {
          parts: [{ text: `Sen Nanokar'ın AI asistanısın.\n\n${knowledgeBase}` }]
        }
      }
    );

    res.json({
      success: true,
      message: response.data.candidates[0].content.parts[0].text
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Dosya yükleme endpoint'i
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });

app.post('/api/upload/documents', upload.array('files'), async (req, res) => {
  try {
    // Yüklenen dökümanları işleyin (PDF, Excel, vb.)
    const files = req.files;
    
    // Dökümanları parse edin ve bilgi tabanına ekleyin
    // ... parsing logic
    
    res.json({ success: true, message: 'Dökümanlar yüklendi' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Sesli arama için Whisper API (OpenAI)
app.post('/api/voice/transcribe', upload.single('audio'), async (req, res) => {
  try {
    const formData = new FormData();
    formData.append('file', fs.createReadStream(req.file.path));
    formData.append('model', 'whisper-1');
    formData.append('language', 'tr');

    const response = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      formData,
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          ...formData.getHeaders()
        }
      }
    );

    res.json({ success: true, text: response.data.text });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Text-to-Speech
app.post('/api/voice/speak', async (req, res) => {
  try {
    const { text } = req.body;
    
    const response = await axios.post(
      'https://api.openai.com/v1/audio/speech',
      {
        model: 'tts-1',
        voice: 'nova',
        input: text
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`
        },
        responseType: 'arraybuffer'
      }
    );

    res.set('Content-Type', 'audio/mpeg');
    res.send(response.data);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Sohbet geçmişi kaydetme
const chatHistory = new Map();

app.post('/api/chat/history', (req, res) => {
  const { sessionId, message } = req.body;
  
  if (!chatHistory.has(sessionId)) {
    chatHistory.set(sessionId, []);
  }
  
  chatHistory.get(sessionId).push(message);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Chatbot API running on port ${PORT}`);
});