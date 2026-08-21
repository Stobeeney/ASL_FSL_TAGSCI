const fs = require('fs');

async function testParse() {
  const CHUNK_SIZE = 512 * 1024; 
  let offset = 0;
  let buffer = '';
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  let objectStart = -1;
  let totalImported = 0;
  let i = 0;

  const fd = fs.openSync('/home/eney/Documents/ASL_FSL_TAGSCI/Dataset_All.json', 'r');
  const stats = fs.fstatSync(fd);
  const FILE_SIZE = stats.size;
  
  while (offset < FILE_SIZE) {
    let toRead = Math.min(CHUNK_SIZE, FILE_SIZE - offset);
    let buf = Buffer.alloc(toRead);
    fs.readSync(fd, buf, 0, toRead, offset);
    const text = buf.toString('utf-8');
    buffer += text;
    offset += CHUNK_SIZE;

    while (i < buffer.length) {
      const char = buffer[i];
      if (escapeNext) {
        escapeNext = false;
        i++;
        continue;
      }
      if (char === '"') {
        inString = !inString;
      } else if (char === '\\' && inString) {
        escapeNext = true;
      } else if (!inString) {
        if (char === '{') {
          if (depth === 0) objectStart = i;
          depth++;
        } else if (char === '}') {
          depth--;
          if (depth === 0 && objectStart !== -1) {
            const objStr = buffer.substring(objectStart, i + 1);
            try {
              JSON.parse(objStr);
              totalImported++;
            } catch(e) {
              console.error("Skipped malformed object:", e.message);
              // console.error("String was:", objStr.substring(0, 100));
            }
            buffer = buffer.substring(i + 1);
            i = -1; 
            objectStart = -1;
          }
        }
      }
      i++;
    }
  }
  fs.closeSync(fd);
  console.log("Total imported:", totalImported);
}

testParse();
