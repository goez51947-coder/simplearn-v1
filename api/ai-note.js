// Vercel Serverless Function: POST /api/ai-note
// Kunci rahasia HANYA di Environment Variables Vercel:
//   GEMINI_API_KEY    (dari Google AI Studio)
//   FIREBASE_API_KEY  (apiKey dari firebaseConfig; dipakai untuk cek login)
//   GEMINI_MODEL      (opsional, default gemini-2.5-flash)
const hits = new Map();

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metode tidak didukung' });
  try {
    const { GEMINI_API_KEY, FIREBASE_API_KEY } = process.env;
    if (!GEMINI_API_KEY || !FIREBASE_API_KEY)
      return res.status(500).json({ error: 'Server AI belum dikonfigurasi (kunci belum diisi di Vercel).' });

    // 1) Pastikan pemanggil sudah login (token Firebase valid)
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Login dulu.' });
    const who = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FIREBASE_API_KEY, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token })
    });
    if (!who.ok) return res.status(401).json({ error: 'Sesi login tidak valid. Login ulang.' });
    const uid = ((await who.json()).users || [])[0]?.localId;
    if (!uid) return res.status(401).json({ error: 'Sesi login tidak valid.' });

    // 2) Batas pemakaian sederhana: 8 permintaan / menit / pengguna
    const now = Date.now();
    const recent = (hits.get(uid) || []).filter(t => now - t < 60000);
    if (recent.length >= 8) return res.status(429).json({ error: 'Terlalu cepat. Tunggu sebentar lalu coba lagi.' });
    recent.push(now); hits.set(uid, recent);

    // 3) Validasi input
    const { image, subject = '', chapter = '', hint = '' } = req.body || {};
    const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(image || '');
    if (!m) return res.status(400).json({ error: 'Foto tidak valid.' });
    if (m[2].length > 4000000) return res.status(413).json({ error: 'Foto terlalu besar.' });

    // 4) Panggil Gemini
    const prompt = `Kamu adalah Simo, asisten belajar untuk siswa SMA/SMK Indonesia.
Baca materi pada foto, lalu susun catatan belajar yang rapi dalam Bahasa Indonesia.
Mata pelajaran: ${String(subject).slice(0, 60)}. ${chapter ? 'Bab/topik: ' + String(chapter).slice(0, 80) + '.' : ''}
${String(hint).slice(0, 300)}
Aturan format isi catatan: gunakan judul bagian dengan tanda #, poin dengan tanda -, dan tulis istilah penting sebagai baris "Istilah: penjelasan" agar bisa dijadikan flashcard. Jangan mengarang isi yang tidak ada di foto. Jika foto tidak terbaca, balas title "Foto tidak terbaca" dan jelaskan singkat di content.`;
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: m[1], data: m[2] } }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: { type: 'OBJECT', properties: { title: { type: 'STRING' }, content: { type: 'STRING' } }, required: ['title', 'content'] }
      }
    });
    const call = (u, h) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body });
    let r = await call(url, { 'x-goog-api-key': GEMINI_API_KEY });
    if ([400, 401, 403].includes(r.status)) {
      // cadangan: beberapa format kunci lebih cocok dikirim lewat parameter ?key=
      const r2 = await call(url + '?key=' + encodeURIComponent(GEMINI_API_KEY), {});
      if (r2.ok) r = r2; else r = r2.status < r.status || r2.status === 429 ? r2 : r;
    }
    if (r.status === 429) return res.status(429).json({ error: 'Kuota AI gratis hari ini sedang penuh. Coba lagi nanti.' });
    if (!r.ok) {
      const raw = (await r.text()).slice(0, 400);
      let msg = raw; try { msg = JSON.parse(raw).error.message || raw; } catch {}
      console.error('Gemini', r.status, raw);
      return res.status(502).json({ error: `AI sedang bermasalah (Gemini ${r.status}): ${String(msg).slice(0, 160)}` });
    }
    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    let note; try { note = JSON.parse(text); } catch { note = null; }
    if (!note || !note.title || !note.content) return res.status(502).json({ error: 'AI belum menghasilkan catatan yang jelas. Coba foto yang lebih terang.' });
    return res.status(200).json({ note: { title: String(note.title), content: String(note.content) } });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Terjadi kesalahan server.' });
  }
};
