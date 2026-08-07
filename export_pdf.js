const { exec } = require('child_process');
const path = require('path');

const htmlPath = path.resolve(__dirname, 'shaxian_travel_ppt.html');
const pdfPath = path.resolve(__dirname, 'shaxian_travel_ppt.pdf');
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const cmd = `"${edgePath}" --headless --disable-gpu --print-to-pdf="${pdfPath}" --no-margins --landscape "file:///${htmlPath.replace(/\\/g, '/')}"`;

console.log('Executing command:', cmd);

exec(cmd, (error, stdout, stderr) => {
    if (error) {
        console.error(`Error: ${error.message}`);
        return;
    }
    console.log('PDF generated successfully at:', pdfPath);
});
