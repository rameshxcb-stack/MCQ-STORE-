import fs from 'fs';
import path from 'path';

export default function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  
  const dbFiles = [];

  function scanDirectory(dir) {
    const files = fs.readdirSync(dir);
    
    files.forEach(file => {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);

      if (stat.isDirectory() && file !== 'node_modules' && file !== '.git' && file !== '.next') {
        scanDirectory(filePath);
      } else if (filePath.endsWith('.js') || filePath.endsWith('.html')) {
        const content = fs.readFileSync(filePath, 'utf8');
        
        if (content.includes('libsql') || content.includes('turso') || content.includes('createClient') || content.includes('TURSO_')) {
          dbFiles.push(filePath);
        }
      }
    });
  }

  try {
    scanDirectory(process.cwd());
    return res.status(200).json({
      status: 'SUCCESS',
      total_files_matched: dbFiles.length,
      files_to_update: dbFiles
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
