// SVG Label Maker - Encoder Module
// Handles SVG to Canvas conversion and bitmap encoding for thermal printers

class LabelEncoder {
    constructor(labelConfig) {
        this.labelConfig = labelConfig;
        this.currentSvgString = null;
    }

    /**
     * Convert SVG element directly to canvas
     * @param {SVGElement} svgElement - SVG DOM element to convert
     * @param {CanvasRenderingContext2D} ctx - Canvas context to draw on
     * @param {number} width - Canvas width
     * @param {number} height - Canvas height
     * @param {number} svgWidth - Original SVG width
     * @param {number} svgHeight - Original SVG height
     * @param {boolean} ditheringEnabled - Whether to apply dithering/threshold
     * @param {number} thresholdLevel - Threshold level for binary conversion
     * @param {Function} callback - Callback function after rendering completes
     * @param {string} ditheringMode - Dithering mode: 'threshold', 'floyd-steinberg', 'ordered', 'atkinson'
     */
    svgElementToCanvas(svgElement, ctx, width, height, svgWidth, svgHeight, ditheringEnabled = false, thresholdLevel = 128, callback = null, ditheringMode = 'threshold') {
        // Clear canvas with white background
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, width, height);
        
        // Serialize the SVG element directly
        const serializer = new XMLSerializer();
        const svgData = serializer.serializeToString(svgElement);
        
        console.log('Converting SVG element to canvas with 2x scaling:', {
            svgDataLength: svgData.length,
            canvasSize: `${width}x${height}`,
            svgSize: `${svgWidth}x${svgHeight}`,
            scaleFactor: '2x',
            ditheringMode: ditheringMode,
            svgPreview: svgData.substring(0, 200) + '...'
        });
        
        const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(svgBlob);
        
        const img = new Image();
        img.crossOrigin = 'anonymous';
        
        img.onload = () => {
            try {
                // Clear and set white background again
                ctx.fillStyle = 'white';
                ctx.fillRect(0, 0, width, height);
                
                // Draw the SVG image scaled 2x (from svgWidth/Height to width/height)
                ctx.drawImage(img, 0, 0, svgWidth, svgHeight, 0, 0, width, height);
                
                // Apply dithering if enabled
                if (ditheringEnabled && ditheringMode !== 'none') {
                    this.applyDithering(ctx, width, height, thresholdLevel, ditheringMode);
                }
                
                console.log('SVG successfully rendered to canvas at 300 DPI (2x scaling)' + (ditheringEnabled ? ` with ${ditheringMode} dithering` : ''));
                URL.revokeObjectURL(url);
                
                if (callback) callback();
            } catch (error) {
                console.error('Error drawing SVG to canvas:', error);
                URL.revokeObjectURL(url);
            }
        };
        
        img.onerror = (error) => {
            console.error('Error loading SVG image:', error);
            URL.revokeObjectURL(url);
            
            // Draw a simple rectangle as last resort
            this.drawBasicCanvas(ctx, width, height, ditheringEnabled, thresholdLevel, ditheringMode);
            
            if (callback) callback();
        };
        
        img.src = url;
        
        // Store the SVG string for display
        this.currentSvgString = svgData;
    }

    /**
     * Convert SVG to canvas with specified dimensions and scaling
     * @param {CanvasRenderingContext2D} ctx - Canvas context to draw on
     * @param {number} width - Canvas width
     * @param {number} height - Canvas height
     * @param {number} svgWidth - Original SVG width
     * @param {number} svgHeight - Original SVG height
     * @param {Array} textElements - Array of SVG text elements
     * @param {boolean} binaryThresholdEnabled - Whether to apply binary threshold
     * @param {number} thresholdLevel - Threshold level for binary conversion
     * @param {Function} callback - Callback function after rendering completes
     */
    svgToCanvas(ctx, width, height, svgWidth, svgHeight, textElements, binaryThresholdEnabled = false, thresholdLevel = 128, callback = null) {
        // Clear canvas with white background
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, width, height);
        
        // Get SVG data with proper namespaces and styling
        const svgData = this.prepareSVGForCanvas(svgWidth, svgHeight, textElements);
        
        console.log('Converting SVG to canvas with 2x scaling:', {
            svgDataLength: svgData.length,
            canvasSize: `${width}x${height}`,
            svgSize: `${svgWidth}x${svgHeight}`,
            scaleFactor: '2x',
            svgPreview: svgData.substring(0, 200) + '...'
        });
        
        const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(svgBlob);
        
        const img = new Image();
        img.crossOrigin = 'anonymous';
        
        img.onload = () => {
            try {
                // Clear and set white background again
                ctx.fillStyle = 'white';
                ctx.fillRect(0, 0, width, height);
                
                // Draw the SVG image scaled 2x (from svgWidth/Height to width/height)
                ctx.drawImage(img, 0, 0, svgWidth, svgHeight, 0, 0, width, height);
                
                // Apply binary threshold if enabled
                if (binaryThresholdEnabled) {
                    this.applyBinaryThreshold(ctx, width, height, thresholdLevel);
                }
                
                console.log('SVG successfully rendered to canvas at 300 DPI (2x scaling)' + (binaryThresholdEnabled ? ' with binary threshold' : ''));
                URL.revokeObjectURL(url);
                
                if (callback) callback();
            } catch (error) {
                console.error('Error drawing SVG to canvas:', error);
                URL.revokeObjectURL(url);
            }
        };
        
        img.onerror = (error) => {
            console.error('Error loading SVG image, trying fallback:', error);
            URL.revokeObjectURL(url);
            
            // Try with fallback SVG
            const fallbackSvg = this.getFallbackSVG(svgWidth, svgHeight);
            const fallbackBlob = new Blob([fallbackSvg], { type: 'image/svg+xml;charset=utf-8' });
            const fallbackUrl = URL.createObjectURL(fallbackBlob);
            
            const fallbackImg = new Image();
            fallbackImg.onload = () => {
                try {
                    ctx.fillStyle = 'white';
                    ctx.fillRect(0, 0, width, height);
                    ctx.drawImage(fallbackImg, 0, 0, svgWidth, svgHeight, 0, 0, width, height);
                    
                    // Apply binary threshold if enabled
                    if (binaryThresholdEnabled) {
                        this.applyBinaryThreshold(ctx, width, height, thresholdLevel);
                    }
                    
                    console.log('Fallback SVG rendered to canvas at 300 DPI (2x scaling)' + (binaryThresholdEnabled ? ' with binary threshold' : ''));
                    
                    if (callback) callback();
                } catch (fallbackError) {
                    console.error('Fallback also failed:', fallbackError);
                    // Draw a simple rectangle as last resort
                    this.drawBasicCanvas(ctx, width, height, binaryThresholdEnabled, thresholdLevel);
                    
                    if (callback) callback();
                }
                URL.revokeObjectURL(fallbackUrl);
            };
            
            fallbackImg.onerror = () => {
                console.error('Fallback SVG also failed, drawing basic canvas');
                this.drawBasicCanvas(ctx, width, height, binaryThresholdEnabled, thresholdLevel);
                URL.revokeObjectURL(fallbackUrl);
                
                if (callback) callback();
            };
            
            fallbackImg.src = fallbackUrl;
        };
        
        img.src = url;
    }

    /**
     * Draw a basic canvas as last resort fallback
     */
    drawBasicCanvas(ctx, width, height, ditheringEnabled, thresholdLevel, ditheringMode = 'threshold') {
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, width, height);
        ctx.strokeStyle = 'black';
        ctx.strokeRect(0, 0, width, height);
        ctx.fillStyle = 'black';
        ctx.font = '16px Arial';
        ctx.fillText('Label', 10, 30);
        
        // Apply dithering if enabled
        if (ditheringEnabled && ditheringMode !== 'none') {
            this.applyDithering(ctx, width, height, thresholdLevel, ditheringMode);
        }
    }

    /**
     * Prepare SVG string for canvas rendering
     * @param {number} widthPx - Width in pixels
     * @param {number} heightPx - Height in pixels
     * @param {Array} textElements - Array of SVG text elements
     * @returns {string} SVG string
     */
    prepareSVGForCanvas(widthPx, heightPx, textElements) {
        try {
            // Create a clean SVG string manually to avoid serialization issues
            let svgContent = '';
            
            // Always add a white rectangle background first to ensure proper white background
            svgContent += `<rect x="0" y="0" width="${widthPx}" height="${heightPx}" fill="#FFFFFF"/>`;
            
            // Add the main background rectangle with user settings (no border for clean encoding)
            const bgColor = '#FFFFFF'; // Force pure white for encoding
            svgContent += `<rect width="${widthPx}" height="${heightPx}" `;
            svgContent += `fill="${bgColor}" `;
            svgContent += `stroke="none" `;  // Remove border for clean bitmap
            svgContent += `stroke-width="0"`;
            if (this.labelConfig.borderRadius > 0) {
                svgContent += ` rx="${this.labelConfig.borderRadius}" ry="${this.labelConfig.borderRadius}"`;
            }
            svgContent += '/>';
            
            // Add text elements
            textElements.forEach(textElement => {
                const x = textElement.getAttribute('x') || 0;
                const y = textElement.getAttribute('y') || 0;
                const fontSize = textElement.style.fontSize || '16px';
                const fontFamily = textElement.style.fontFamily || 'Arial, sans-serif';
                const fill = textElement.style.fill || 'black';
                const fontWeight = textElement.style.fontWeight || 'normal';
                const fontStyle = textElement.style.fontStyle || 'normal';
                const textDecoration = textElement.style.textDecoration || 'none';
                const textAnchor = textElement.getAttribute('text-anchor') || 'start';
                const dominantBaseline = textElement.getAttribute('dominant-baseline') || 'hanging';
                const textContent = textElement.textContent || '';
                
                svgContent += `<text x="${x}" y="${y}" `;
                svgContent += `font-size="${fontSize}" `;
                svgContent += `font-family="${fontFamily}" `;
                svgContent += `fill="${fill}" `;
                svgContent += `font-weight="${fontWeight}" `;
                svgContent += `font-style="${fontStyle}" `;
                svgContent += `text-decoration="${textDecoration}" `;
                svgContent += `text-anchor="${textAnchor}" `;
                svgContent += `dominant-baseline="${dominantBaseline}">`;
                svgContent += this.escapeXmlText(textContent);
                svgContent += '</text>';
            });
            
            // Create complete SVG string
            const svgString = `<svg width="${widthPx}" height="${heightPx}" viewBox="0 0 ${widthPx} ${heightPx}" ` +
                             `xmlns="http://www.w3.org/2000/svg">${svgContent}</svg>`;
            
            console.log('Prepared SVG for canvas:', {
                dimensions: `${widthPx}x${heightPx}`,
                textElements: textElements.length,
                svgLength: svgString.length
            });
            
            // Store the SVG string for display
            this.currentSvgString = svgString;
            
            return svgString;
            
        } catch (error) {
            console.error('Error preparing SVG for canvas:', error);
            return this.getFallbackSVG(widthPx, heightPx);
        }
    }

    /**
     * Escape XML special characters in text
     */
    escapeXmlText(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * Get fallback SVG when main rendering fails
     */
    getFallbackSVG(widthPx, heightPx) {
        return `<svg width="${widthPx}" height="${heightPx}" viewBox="0 0 ${widthPx} ${heightPx}" xmlns="http://www.w3.org/2000/svg">
            <rect x="0" y="0" width="${widthPx}" height="${heightPx}" fill="#FFFFFF"/>
            <rect width="${widthPx}" height="${heightPx}" fill="#FFFFFF" stroke="none" stroke-width="0"/>
            <text x="10" y="30" font-size="16" font-family="Arial" fill="black">Label</text>
        </svg>`;
    }

    /**
     * Apply dithering/threshold to canvas based on selected mode
     * @param {CanvasRenderingContext2D} ctx - Canvas context
     * @param {number} width - Canvas width
     * @param {number} height - Canvas height
     * @param {number} thresholdLevel - Threshold value (0-255)
     * @param {string} ditheringMode - Dithering mode: 'threshold', 'floyd-steinberg', 'ordered', 'atkinson'
     */
    applyDithering(ctx, width, height, thresholdLevel, ditheringMode = 'threshold') {
        switch (ditheringMode) {
            case 'floyd-steinberg':
                this.applyFloydSteinberg(ctx, width, height);
                break;
            case 'ordered':
                this.applyOrderedDithering(ctx, width, height);
                break;
            case 'atkinson':
                this.applyAtkinsonDithering(ctx, width, height);
                break;
            case 'threshold':
            default:
                this.applyBinaryThreshold(ctx, width, height, thresholdLevel);
                break;
        }
    }

    /**
     * Apply binary threshold to canvas (convert to pure black/white)
     * @param {CanvasRenderingContext2D} ctx - Canvas context
     * @param {number} width - Canvas width
     * @param {number} height - Canvas height
     * @param {number} thresholdLevel - Threshold value (0-255)
     */
    applyBinaryThreshold(ctx, width, height, thresholdLevel) {
        const imageData = ctx.getImageData(0, 0, width, height);
        const data = imageData.data;
        
        for (let i = 0; i < data.length; i += 4) {
            const grayscale = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
            const binaryValue = grayscale >= thresholdLevel ? 255 : 0;
            
            data[i] = binaryValue;
            data[i + 1] = binaryValue;
            data[i + 2] = binaryValue;
        }
        
        ctx.putImageData(imageData, 0, 0);
        console.log(`Applied binary threshold ${thresholdLevel} to canvas`);
    }

    /**
     * Apply Floyd-Steinberg dithering (error diffusion)
     */
    applyFloydSteinberg(ctx, width, height) {
        const imageData = ctx.getImageData(0, 0, width, height);
        const data = imageData.data;
        
        // Create grayscale buffer
        const gray = new Float32Array(width * height);
        for (let i = 0; i < gray.length; i++) {
            const idx = i * 4;
            gray[i] = data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
        }
        
        // Apply Floyd-Steinberg dithering
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = y * width + x;
                const oldPixel = gray[idx];
                const newPixel = oldPixel < 128 ? 0 : 255;
                gray[idx] = newPixel;
                const error = oldPixel - newPixel;
                
                // Distribute error to neighboring pixels
                if (x + 1 < width) gray[idx + 1] += error * 7 / 16;
                if (y + 1 < height) {
                    if (x > 0) gray[idx + width - 1] += error * 3 / 16;
                    gray[idx + width] += error * 5 / 16;
                    if (x + 1 < width) gray[idx + width + 1] += error * 1 / 16;
                }
            }
        }
        
        // Write back to image data
        for (let i = 0; i < gray.length; i++) {
            const idx = i * 4;
            const val = gray[i] < 128 ? 0 : 255;
            data[idx] = data[idx + 1] = data[idx + 2] = val;
        }
        
        ctx.putImageData(imageData, 0, 0);
        console.log('Applied Floyd-Steinberg dithering');
    }

    /**
     * Apply Ordered (Bayer) dithering using 4x4 matrix
     */
    applyOrderedDithering(ctx, width, height) {
        const imageData = ctx.getImageData(0, 0, width, height);
        const data = imageData.data;
        
        // 4x4 Bayer matrix (normalized to 0-255 range)
        const bayerMatrix = [
            [  0, 128,  32, 160],
            [192,  64, 224,  96],
            [ 48, 176,  16, 144],
            [240, 112, 208,  80]
        ];
        
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                const grayscale = data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
                const threshold = bayerMatrix[y % 4][x % 4];
                const binaryValue = grayscale > threshold ? 255 : 0;
                
                data[idx] = data[idx + 1] = data[idx + 2] = binaryValue;
            }
        }
        
        ctx.putImageData(imageData, 0, 0);
        console.log('Applied Ordered (Bayer) dithering');
    }

    /**
     * Apply Atkinson dithering (lighter, good for thermal printers)
     */
    applyAtkinsonDithering(ctx, width, height) {
        const imageData = ctx.getImageData(0, 0, width, height);
        const data = imageData.data;
        
        // Create grayscale buffer
        const gray = new Float32Array(width * height);
        for (let i = 0; i < gray.length; i++) {
            const idx = i * 4;
            gray[i] = data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
        }
        
        // Apply Atkinson dithering (only distributes 6/8 of error, giving lighter result)
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = y * width + x;
                const oldPixel = gray[idx];
                const newPixel = oldPixel < 128 ? 0 : 255;
                gray[idx] = newPixel;
                const error = (oldPixel - newPixel) / 8;
                
                // Distribute error (Atkinson pattern)
                if (x + 1 < width) gray[idx + 1] += error;
                if (x + 2 < width) gray[idx + 2] += error;
                if (y + 1 < height) {
                    if (x > 0) gray[idx + width - 1] += error;
                    gray[idx + width] += error;
                    if (x + 1 < width) gray[idx + width + 1] += error;
                }
                if (y + 2 < height) {
                    gray[idx + width * 2] += error;
                }
            }
        }
        
        // Write back to image data
        for (let i = 0; i < gray.length; i++) {
            const idx = i * 4;
            const val = gray[i] < 128 ? 0 : 255;
            data[idx] = data[idx + 1] = data[idx + 2] = val;
        }
        
        ctx.putImageData(imageData, 0, 0);
        console.log('Applied Atkinson dithering');
    }

    /**
     * Calculate page length in pixels based on DPI
     * @param {number} dpi - Dots per inch (default 150)
     * @returns {number} Page length in pixels
     */
    getPageLengthPixel(dpi = 150) {
        const pixelsPerMm = dpi / 25.4;
        const height = this.labelConfig.height - 6; // label has 6mm margin for cutting
        const heightPx = Math.floor(height * pixelsPerMm);

        console.log(`Page length in pixels: ${heightPx}`);
        return heightPx;
    }

    /**
     * Encode canvas to bitmap format for thermal printer
     * @param {HTMLCanvasElement} canvas - Canvas element to encode
     * @returns {string} Encoded bitmap commands
     */
    encodeBitmap(canvas) {
        const ctx = canvas.getContext('2d');
        const width = canvas.width;
        const height = canvas.height;
        
        if (width === 0 || height === 0) {
            throw new Error('Canvas is empty - add some content first');
        }
        
        const allChunks = [];

        // Loop through the image height in 48-pixel chunks
        for (let startRow = 0; startRow < height; startRow += 48) {
            const chunk = this.encodePixels48(ctx, width, height, startRow);
            allChunks.push(chunk);
        }
        
        const pageLengthPixel = this.getPageLengthPixel(300);
        const l1 = (pageLengthPixel % 256).toString(16).padStart(2, '0');
        const l2 = Math.floor(pageLengthPixel / 256).toString(16).padStart(2, '0');

        // Join all chunks with newlines
        const setupPage = `ESC i a 00
ESC @
ESC i L 00
ESC ( C 02 00 ${l1} ${l2}
ESC ( c 04 00 00 00 00 00`;
        const imageCode = allChunks.join('\n');
        const print = '0C';

        return setupPage + '\n' + imageCode + '\n' + print;
    }

    /**
     * Encode 48 rows of pixels starting from startRow
     * @param {CanvasRenderingContext2D} ctx - Canvas context
     * @param {number} width - Canvas width
     * @param {number} height - Canvas height
     * @param {number} startRow - Starting row for this chunk
     * @returns {string} Encoded bitmap chunk commands
     */
    encodePixels48(ctx, width, height, startRow) {
//        console.log(`Encoding pixels from row ${startRow} to ${startRow + 48}`);
        const imageData = ctx.getImageData(0, startRow, width, Math.min(height - startRow, 48)).data;
        const allColumns = [];
        
        // Loop through each column (x coordinate)
        for (let x = 0; x < width; x++) {
            // Array to store the 6 bytes for this column (48 pixels / 8 pixels per byte = 6 bytes)
            const bytes = [0, 0, 0, 0, 0, 0];
            
            // Process each pixel in the column
            for (let y = 0; y < 48; y++) {               
                if ((imageData[(y * width + x) * 4] ?? 255) >= 128) continue; // white color, no need to push bits
                bytes[Math.floor(y / 8)] |= (1 << (7 - (y % 8)));
            }
            
            // Convert bytes to hex string for this column
            const hexBytes = bytes.map(byte => byte.toString(16).toUpperCase().padStart(2, '0'));
            allColumns.push(hexBytes.join(' '));
        }

        const data = allColumns.join(' ');
        const m0 = 'ESC $ 00 00'; // move to x=0
        const m1 = `ESC ( V 02 00 ${((startRow) % 256).toString(16).padStart(2, '0')} ${Math.floor((startRow) / 256).toString(16).padStart(2, '0')}`; // move to y=startRow
        const n1 = (width % 256).toString(16).padStart(2, '0');
        const n2 = Math.floor(width / 256).toString(16).padStart(2, '0');

        return `${m0}
${m1}
ESC * 48 ${n1} ${n2} ${data}`;
    }

    /**
     * Format SVG code for display with indentation
     * @param {string} svgString - Raw SVG string
     * @returns {string} Formatted SVG string
     */
    formatSvgCode(svgString) {
        // Add line breaks and indentation for better readability
        let formatted = svgString
            .replace(/></g, '>\n<')  // Add newlines between tags
            .replace(/<rect/g, '  <rect')  // Indent rect tags
            .replace(/<text/g, '  <text')  // Indent text tags
            .replace(/<\/text>/g, '</text>')  // Keep closing tags inline
            .replace(/<svg/g, '<svg');  // Keep svg tag at start
        
        return formatted;
    }

    /**
     * Get the current SVG string
     * @returns {string} Current SVG string
     */
    getCurrentSvgString() {
        return this.currentSvgString;
    }
}
