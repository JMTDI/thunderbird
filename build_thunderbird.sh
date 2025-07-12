#!/bin/bash
# Simple build script for Thunderbird with HTTPS link compose feature
# This script assumes you have the complete mozilla-central + comm-central setup

set -e

echo "=== Building Thunderbird with HTTPS Link Compose Feature ==="

# Check if we're in the right directory
if [ ! -f "mach" ]; then
    echo "Error: mach not found. Please run this script from the mozilla-central directory."
    echo "Expected structure:"
    echo "  mozilla-central/"
    echo "  ├── mach"
    echo "  └── comm/"
    echo "      └── mail/"
    exit 1
fi

# Check if comm directory exists
if [ ! -d "comm" ]; then
    echo "Error: comm directory not found. Please ensure comm-central is cloned into comm/"
    exit 1
fi

# Create or update mozconfig for Thunderbird
echo "Creating mozconfig for Thunderbird..."
cat > mozconfig << 'EOF'
# Enable Thunderbird build
ac_add_options --enable-project=comm/mail

# Optimization settings
ac_add_options --enable-optimize
ac_add_options --disable-debug
ac_add_options --disable-debug-symbols

# For faster builds (optional)
ac_add_options --enable-ccache

# Windows-specific options (uncomment if cross-compiling for Windows)
# ac_add_options --target=x86_64-pc-windows-msvc
# ac_add_options --enable-cross-compile

# macOS-specific options (uncomment if building for macOS)
# ac_add_options --target=x86_64-apple-darwin

EOF

echo "mozconfig created successfully"

# Show the applied changes
echo "=== Applied Changes ==="
echo "Modified file: comm/mail/base/content/contentAreaClick.js"
echo "Feature: HTTPS links now open compose window instead of browser"
echo ""

# Start the build
echo "Starting build process..."
echo "This may take 30 minutes to several hours depending on your system..."

./mach build

echo ""
echo "=== Build Complete ==="
echo "To run your custom Thunderbird:"
echo "  ./mach run"
echo ""
echo "To package for distribution:"
echo "  ./mach package"
echo ""
echo "The executable will be located in:"
echo "  obj-*/dist/bin/thunderbird (Linux)"
echo "  obj-*/dist/bin/thunderbird.exe (Windows)"
echo "  obj-*/dist/Daily.app/Contents/MacOS/thunderbird (macOS)"
