// SVG Label Maker - Printer Module
// Handles WebUSB printing and printer server communication

// ==================== Compression Functions ====================
function compressRLE(bytes) {
    // Run-Length Encoding: compress repetitive sequences
    const compressed = [];
    let i = 0;
    
    while (i < bytes.length) {
        const currentByte = bytes[i];
        let count = 1;
        
        // Count consecutive identical bytes (max 255)
        while (i + count < bytes.length && bytes[i + count] === currentByte && count < 255) {
            count++;
        }
        
        // IMPORTANT: Always encode byte 255 using RLE format to avoid ambiguity
        // This prevents standalone 255 bytes from being misinterpreted as RLE markers
        if (count > 3 || currentByte === 255) {
            // If we have 4+ repeated bytes OR byte value is 255, use RLE format
            // Format: [255, count, byte]
            compressed.push(255, count, currentByte);
            i += count;
        } else {
            // For short sequences (and not byte 255), store as-is
            for (let j = 0; j < count; j++) {
                compressed.push(currentByte);
            }
            i += count;
        }
    }
    
    return compressed;
}

// ==================== Printer Server Functions ====================
async function sendToPrinterServer(hexCommand) {
    const serverEnabled = localStorage.getItem('checkin_printer_server_enabled') === 'true';
    const serverUrl = localStorage.getItem('checkin_printer_server_url') || 'https://labelmaker.local/print';
    const selectedPrinterHost = localStorage.getItem('checkin_selected_printer_host');
    
    if (!serverEnabled) {
        throw new Error('Printer server is not enabled');
    }
    
    // Step 1: Convert hex command string to bytes
    const hexBytes = hexCommand.split(' ').filter(h => h.trim());
    const bytes = hexBytes.map(hex => {
        if (hex.length === 2) {
            return parseInt(hex, 16);
        }
        // If it's ASCII, convert to decimal
        return hex.charCodeAt(0);
    });
    
    const originalLength = bytes.length;
    console.log('Original bytes:', originalLength);
    
    // Step 2: Compress using RLE
    const compressedBytes = compressRLE(bytes);
    const compressedLength = compressedBytes.length;
    const compressionRatio = ((1 - compressedLength / originalLength) * 100).toFixed(1);
    console.log('Compressed bytes:', compressedLength, `(${compressionRatio}% reduction)`);
    
    // Step 3: Convert compressed bytes to base64
    const base64String = btoa(String.fromCharCode(...compressedBytes));
    console.log('Base64 string length:', base64String.length);

    // Build request body
    const requestBody = {
        test: false,
        encodedData: base64String,
        encoding: 'rle-base64' // Indicate the encoding format
    };
    
    // Add printer host if selected
    if (selectedPrinterHost) {
        requestBody.printerHost = selectedPrinterHost;
        console.log('Using selected printer:', selectedPrinterHost);
    }

    try {
        const response = await fetch(serverUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody)
        });
        
        if (!response.ok) {
            throw new Error(`Server returned ${response.status}: ${response.statusText}`);
        }
        
        const result = await response.json();
        console.log('Print sent to server successfully:', result);
        return result;
    } catch (error) {
        console.error('Error sending to printer server:', error);
        throw error;
    }
}

// ==================== Printer Mode Detection ====================
function getPrinterMode() {
    const usbEnabled = localStorage.getItem('checkin_usb_printer_enabled') === 'true';
    const serverEnabled = localStorage.getItem('checkin_printer_server_enabled') === 'true';
    
    if (serverEnabled) {
        return 'server';
    } else if (usbEnabled) {
        return 'usb';
    } else {
        return 'none';
    }
}

// ==================== WebUSB Raw Print Functionality ====================
async function requestUSBDevice() {
    try {
        const device = await navigator.usb.requestDevice({
            filters: [{ vendorId: 0x04f9 }] // Brother vendor ID
        });
        console.log('Device requested successfully:', device);
        return device;
    } catch (error) {
        console.error('Error requesting USB device:', error);
        alert('Failed to request USB device. Make sure you have a Brother printer connected.');
        throw error;
    }
}

// ==================== Unified Print Function ====================
async function connectAndPrint() {
    const printerMode = getPrinterMode();
    
    if (printerMode === 'none') {
        alert('No printer configured. Please enable either USB Printer or Printer Server in Settings.');
        return false;
    }
    
    // Get the hex command from the textarea (try bitmapOutput first, fallback to hexCommand)
    const bitmapOutput = document.getElementById('bitmapOutput');
    const hexCommandElement = document.getElementById('hexCommand');
    const hexCommand = (bitmapOutput?.value || hexCommandElement?.value || '').replaceAll('\n', ' ').replaceAll('ESC', '1B');
    
    if (!hexCommand) {
        alert('No print data available');
        return false;
    }
    
    try {
        if (printerMode === 'server') {
            await sendToPrinterServer(hexCommand);
            console.log('Print sent to server successfully!');
        } else if (printerMode === 'usb') {
            if (await connectAndPrintUSB(hexCommand) === false) return false;
        }
        return true;
    } catch (error) {
        console.error('Error during printing:', error);
        alert('Error during printing: ' + error.message);
        return false;
    }
}

// ==================== USB Print Function ====================
async function connectAndPrintUSB(hexCommand) {
    let device = null;
    let interfaceClaimed = false;
    let interfaceNumber = null;
    
    try {
        if (!navigator.usb) {
            alert('WebUSB is not supported in this browser. Please use Chrome or Edge.');
            return false;
        }

        const devices = await navigator.usb.getDevices();
        
        const brotherDevices = devices.filter(device => 
            device.manufacturerName && device.manufacturerName.toLowerCase().includes('brother')
        );
        
        if (brotherDevices.length === 0) {
            alert('No Brother devices found. Please use "Request Device" first to pair your printer.');
            return false;
        }

        device = brotherDevices[0];
        console.log('Using device:', device);
        
        // Only open if not already opened
        if (!device.opened) {
            await device.open();
        }

        if (device.configuration === null) {
            await device.selectConfiguration(1);
        }

        const interfaces = device.configuration.interfaces;
        const printerInterface = interfaces[0];
        interfaceNumber = printerInterface.interfaceNumber;
        
        // Claim the interface before using it
        await device.claimInterface(interfaceNumber);
        interfaceClaimed = true;
        
        const alternate = printerInterface.alternate;
        const endpoint = alternate.endpoints.find(endpoint => 
            endpoint.direction === 'out' && endpoint.type === 'bulk'
        );

        if (!endpoint) {
            throw new Error('No bulk out endpoint found');
        }
        
        // Parse hex string to bytes
        const hexBytes = hexCommand.split(' ');
        const bytes = hexBytes.map(hex => {
            if (hex.length === 2) return parseInt(hex, 16);
            // hex is ascii, convert to decimal
            return hex.charCodeAt(0);
        });

        const buffer = new Uint8Array(bytes);
        console.log('Sending buffer:', buffer);

        const result = await device.transferOut(endpoint.endpointNumber, buffer);
        console.log('Transfer result:', result);

        if (result.status !== 'ok') {
            throw new Error(`Transfer failed: ${result.status}`);
        }
        
        console.log('Print command sent successfully!');
        return true;
        
    } catch (error) {
        console.error('Error during USB printing:', error);
        throw error;
    } finally {
        // Clean up: release interface and close device
        if (device && interfaceClaimed && interfaceNumber !== null) {
            try {
                await device.releaseInterface(interfaceNumber);
                console.log('Interface released');
            } catch (e) {
                console.error('Error releasing interface:', e);
            }
        }
        if (device && device.opened) {
            try {
                await device.close();
                console.log('Device closed');
            } catch (e) {
                console.error('Error closing device:', e);
            }
        }
    }
}

// ==================== Print with Specific Bitmap Element ====================
async function connectAndPrintWithBitmap(bitmapElement) {
    const printerMode = getPrinterMode();
    
    if (printerMode === 'none') {
        alert('No printer configured. Please enable either USB Printer or Printer Server in Settings.');
        return false;
    }
    
    // Get the hex command from the specific bitmap element
    const hexCommand = (bitmapElement?.value || '').replaceAll('\n', ' ').replaceAll('ESC', '1B');
    
    if (!hexCommand) {
        alert('No bitmap data found');
        return false;
    }
    
    try {
        if (printerMode === 'server') {
            await sendToPrinterServer(hexCommand);
            console.log('Print sent to server successfully!');
        } else if (printerMode === 'usb') {
            if (await connectAndPrintUSB(hexCommand) === false) return false;
        }
        return true;
    } catch (error) {
        console.error('Error during printing:', error);
        alert('Error during printing: ' + error.message);
        return false;
    }
}

// ==================== Settings UI Functions ====================
function updatePrinterSettingsUI() {
    const usbEnabled = localStorage.getItem('checkin_usb_printer_enabled') === 'true';
    const serverEnabled = localStorage.getItem('checkin_printer_server_enabled') === 'true';
    const serverUrl = localStorage.getItem('checkin_printer_server_url') || 'https://labelmaker.local/print';
    
    const usbToggle = document.getElementById('usbPrinterToggle');
    const serverToggle = document.getElementById('serverPrinterToggle');
    const serverUrlInput = document.getElementById('printerServerUrl');
    const serverUrlSection = document.getElementById('serverUrlSection');
    const printerStatus = document.getElementById('printerStatus');
    
    if (usbToggle) usbToggle.checked = usbEnabled;
    if (serverToggle) serverToggle.checked = serverEnabled;
    if (serverUrlInput) serverUrlInput.value = serverUrl;
    if (serverUrlSection) serverUrlSection.style.display = serverEnabled ? 'block' : 'none';
    
    // Update status indicator
    if (printerStatus) {
        if (serverEnabled) {
            printerStatus.textContent = 'Server Mode';
            printerStatus.className = 'text-sm font-medium text-green-600';
        } else if (usbEnabled) {
            printerStatus.textContent = 'USB Mode';
            printerStatus.className = 'text-sm font-medium text-blue-600';
        } else {
            printerStatus.textContent = 'Disabled';
            printerStatus.className = 'text-sm font-medium text-gray-500';
        }
    }
}

function initializePrinterSettings() {
    const usbToggle = document.getElementById('usbPrinterToggle');
    const serverToggle = document.getElementById('serverPrinterToggle');
    const serverUrlInput = document.getElementById('printerServerUrl');
    const printerListUrlInput = document.getElementById('printerListUrl');
    const listPrintersBtn = document.getElementById('listPrintersBtn');
    const printerSelectContainer = document.getElementById('printerSelectContainer');
    const printerSelect = document.getElementById('printerSelect');
    const testServerBtn = document.getElementById('testServerBtn');
    
    if (usbToggle) {
        usbToggle.addEventListener('change', () => {
            localStorage.setItem('checkin_usb_printer_enabled', usbToggle.checked);
            if (usbToggle.checked && serverToggle) {
                serverToggle.checked = false;
                localStorage.setItem('checkin_printer_server_enabled', 'false');
            }
            updatePrinterSettingsUI();
        });
    }
    
    if (serverToggle) {
        serverToggle.addEventListener('change', () => {
            localStorage.setItem('checkin_printer_server_enabled', serverToggle.checked);
            if (serverToggle.checked && usbToggle) {
                usbToggle.checked = false;
                localStorage.setItem('checkin_usb_printer_enabled', 'false');
            }
            updatePrinterSettingsUI();
        });
    }
    
    if (serverUrlInput) {
        serverUrlInput.addEventListener('change', () => {
            localStorage.setItem('checkin_printer_server_url', serverUrlInput.value);
        });
    }
    
    // Printer list URL
    if (printerListUrlInput) {
        const savedListUrl = localStorage.getItem('checkin_printer_list_url') || 'https://labelmaker.local/printers/list';
        printerListUrlInput.value = savedListUrl;
        
        printerListUrlInput.addEventListener('change', () => {
            localStorage.setItem('checkin_printer_list_url', printerListUrlInput.value);
        });
    }
    
    // Load saved selected printer
    if (printerSelect) {
        const savedPrinter = localStorage.getItem('checkin_selected_printer_host');
        if (savedPrinter) {
            printerSelectContainer.classList.remove('hidden');
            const option = document.createElement('option');
            option.value = savedPrinter;
            option.textContent = savedPrinter;
            option.selected = true;
            printerSelect.appendChild(option);
        }
        
        printerSelect.addEventListener('change', () => {
            const selectedHost = printerSelect.value;
            if (selectedHost) {
                localStorage.setItem('checkin_selected_printer_host', selectedHost);
                console.log('Selected printer saved:', selectedHost);
            } else {
                localStorage.removeItem('checkin_selected_printer_host');
                console.log('Printer selection cleared');
            }
        });
    }
    
    // List Printers button
    if (listPrintersBtn) {
        listPrintersBtn.addEventListener('click', async () => {
            const url = printerListUrlInput?.value || localStorage.getItem('checkin_printer_list_url') || 'https://labelmaker.local/printers/list';
            const originalText = listPrintersBtn.innerHTML;
            const savedPrinter = localStorage.getItem('checkin_selected_printer_host');
            
            listPrintersBtn.disabled = true;
            listPrintersBtn.innerHTML = '⏳ Fetching...';
            
            try {
                const response = await fetch(url, { method: 'GET' });
                
                if (!response.ok) {
                    throw new Error(`Server returned ${response.status}: ${response.statusText}`);
                }
                
                const data = await response.json();
                
                if (!data.success || !data.printers || data.printers.length === 0) {
                    throw new Error('No printers found');
                }
                
                // Clear existing options
                printerSelect.innerHTML = '<option value="">-- Select a printer --</option>';
                
                // Populate select with printer host names
                data.printers.forEach(printer => {
                    const option = document.createElement('option');
                    option.value = printer.host;
                    option.textContent = `${printer.name} (${printer.host})`;
                    
                    if (savedPrinter && printer.host === savedPrinter) {
                        option.selected = true;
                    }
                    
                    printerSelect.appendChild(option);
                });
                
                printerSelectContainer.classList.remove('hidden');
                
                listPrintersBtn.innerHTML = `✅ Found ${data.count} printer(s)`;
                listPrintersBtn.classList.remove('bg-blue-100', 'hover:bg-blue-200', 'text-blue-700');
                listPrintersBtn.classList.add('bg-green-100', 'text-green-700');
                
                setTimeout(() => {
                    listPrintersBtn.innerHTML = originalText;
                    listPrintersBtn.classList.remove('bg-green-100', 'text-green-700');
                    listPrintersBtn.classList.add('bg-blue-100', 'hover:bg-blue-200', 'text-blue-700');
                    listPrintersBtn.disabled = false;
                }, 3000);
                
                console.log('Printers loaded:', data.printers);
            } catch (error) {
                console.error('Failed to fetch printers:', error);
                listPrintersBtn.innerHTML = '❌ Failed';
                listPrintersBtn.classList.remove('bg-blue-100', 'hover:bg-blue-200', 'text-blue-700');
                listPrintersBtn.classList.add('bg-red-100', 'text-red-700');
                
                alert('Failed to fetch printers. Please make sure:\n1. Server is running\n2. URL is correct\n3. CORS is enabled on server');
                
                setTimeout(() => {
                    listPrintersBtn.innerHTML = originalText;
                    listPrintersBtn.classList.remove('bg-red-100', 'text-red-700');
                    listPrintersBtn.classList.add('bg-blue-100', 'hover:bg-blue-200', 'text-blue-700');
                    listPrintersBtn.disabled = false;
                }, 3000);
            }
        });
    }
    
    // Test Server Connection button
    if (testServerBtn) {
        testServerBtn.addEventListener('click', async () => {
            const url = serverUrlInput?.value || localStorage.getItem('checkin_printer_server_url') || 'https://labelmaker.local/print';
            const originalText = testServerBtn.innerHTML;
            
            testServerBtn.disabled = true;
            testServerBtn.innerHTML = '⏳ Testing...';
            
            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        test: true,
                        hexCommand: '1B 69 61 01'
                    })
                });
                
                if (response.ok) {
                    testServerBtn.innerHTML = '✅ Connected!';
                    testServerBtn.classList.remove('bg-gray-100', 'hover:bg-gray-200', 'text-gray-700');
                    testServerBtn.classList.add('bg-green-100', 'text-green-700');
                    
                    setTimeout(() => {
                        testServerBtn.innerHTML = originalText;
                        testServerBtn.classList.remove('bg-green-100', 'text-green-700');
                        testServerBtn.classList.add('bg-gray-100', 'hover:bg-gray-200', 'text-gray-700');
                        testServerBtn.disabled = false;
                    }, 3000);
                } else {
                    throw new Error(`Server returned ${response.status}`);
                }
            } catch (error) {
                console.error('Server connection test failed:', error);
                testServerBtn.innerHTML = '❌ Failed';
                testServerBtn.classList.remove('bg-gray-100', 'hover:bg-gray-200', 'text-gray-700');
                testServerBtn.classList.add('bg-red-100', 'text-red-700');
                
                alert('Failed to connect to printer server. Please make sure:\n1. Server is running\n2. URL is correct\n3. CORS is enabled on server');
                
                setTimeout(() => {
                    testServerBtn.innerHTML = originalText;
                    testServerBtn.classList.remove('bg-red-100', 'text-red-700');
                    testServerBtn.classList.add('bg-gray-100', 'hover:bg-gray-200', 'text-gray-700');
                    testServerBtn.disabled = false;
                }, 3000);
            }
        });
    }
    
    // Initial UI update
    updatePrinterSettingsUI();
}

// ==================== Refresh Printers Function ====================
async function refreshPrinters(button) {
    const originalText = button.innerHTML;
    
    button.disabled = true;
    button.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Refreshing...';
    
    try {
        const response = await fetch('https://labelmaker.local/printers/refresh', {
            method: 'GET'
        });
        
        if (!response.ok) {
            throw new Error(`Server returned ${response.status}: ${response.statusText}`);
        }
        
        // Response may be empty, just treat 200 as success
        console.log('Printers refresh triggered successfully');
        
        button.innerHTML = '<i class="fas fa-check mr-2"></i>Refreshed!';
        button.classList.remove('bg-orange-100', 'hover:bg-orange-200', 'text-orange-700');
        button.classList.add('bg-green-100', 'text-green-700');
        
        setTimeout(() => {
            button.innerHTML = originalText;
            button.classList.remove('bg-green-100', 'text-green-700');
            button.classList.add('bg-orange-100', 'hover:bg-orange-200', 'text-orange-700');
            button.disabled = false;
        }, 2000);
    } catch (error) {
        console.error('Failed to refresh printers:', error);
        button.innerHTML = '<i class="fas fa-times mr-2"></i>Failed';
        button.classList.remove('bg-orange-100', 'hover:bg-orange-200', 'text-orange-700');
        button.classList.add('bg-red-100', 'text-red-700');
        
        setTimeout(() => {
            button.innerHTML = originalText;
            button.classList.remove('bg-red-100', 'text-red-700');
            button.classList.add('bg-orange-100', 'hover:bg-orange-200', 'text-orange-700');
            button.disabled = false;
        }, 3000);
        
        throw error;
    }
}

// The CMS admin shell may inject this script after DOMContentLoaded. Initialise
// immediately in that case so the settings controls can persist their values.
function initPrinterPage() {
    // Initialize printer settings
    initializePrinterSettings();
    
    // WebUSB button event listeners
    const manualRequestButton = document.getElementById('manualRequest');
    const rawPrintButton = document.getElementById('rawPrint');
    const refreshPrintersButton = document.getElementById('refresh_printers');
    
    if (manualRequestButton) {
        manualRequestButton.addEventListener('click', async () => {
            await requestUSBDevice();
        });
    }
    
    if (rawPrintButton) {
        rawPrintButton.addEventListener('click', async () => {
            await connectAndPrint();
        });
    }
    
    if (refreshPrintersButton) {
        refreshPrintersButton.addEventListener('click', async () => {
            await refreshPrinters(refreshPrintersButton);
        });
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPrinterPage);
} else {
    initPrinterPage();
}
