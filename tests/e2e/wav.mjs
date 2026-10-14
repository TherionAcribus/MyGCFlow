// WAV PCM 16 bits mono : `toneSeconds` de la 440 Hz puis `silenceSeconds` de
// silence numérique. Généré en mémoire pour ne pas versionner de binaire ;
// directement utilisable par setInputFiles.
export function wavFile(name, toneSeconds, silenceSeconds) {
  const rate = 8000;
  const toneSamples = Math.round(toneSeconds * rate);
  const total = toneSamples + Math.round(silenceSeconds * rate);
  const buffer = Buffer.alloc(44 + total * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + total * 2, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(total * 2, 40);
  for (let i = 0; i < toneSamples; i++) {
    buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 16000), 44 + i * 2);
  }
  return { name, mimeType: 'audio/wav', buffer };
}
