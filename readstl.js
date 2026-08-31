const fs = require('fs');
const path = require('path');
const filePath = path.join('C:', path.sep, 'Users', 'User', 'Documents', 'Nativos 3D', 'Site Modelos stl', 'CONVERTOR3D', 'joker.stl');
const buf = fs.readFileSync(filePath);
const size = buf.length;
console.log('Tamanho:', size);
// Check first bytes - binary STL starts with triangle count
const first4 = buf.readUInt32LE(0);
console.log('First 4 bytes (uint32 LE):', first4);
// Check for ASCII 'solid' header
const asciiStart = buf.toString('ascii', 0, 5);
console.log('First 5 bytes ascii:', asciiStart);
// Check last 100 bytes
console.log('Last 100 bytes hex:', buf.slice(-100).toString('hex'));
// Try reading as ASCII STL
const content = buf.toString('ascii');
const solidIndex = content.indexOf('solid');
console.log('Indice "solid":', solidIndex);
if (solidIndex >= 0) {
    // Get the name
    const nameLine = content.substring(solidIndex, solidIndex + 50);
    console.log('Name line:', nameLine.trim());
}
// Check for binary pattern - 80 byte header + 4 byte count
const hasTriCount = buf.length > 84;
console.log('Tamanho > 84:', hasTriCount);
if (hasTriCount) {
    const triangleCount = buf.readUInt32LE(80);
    console.log('Triangle count at offset 80:', triangleCount);
    console.log('Expected size: 84 +', triangleCount * 50, '=', 84 + triangleCount * 50);
}