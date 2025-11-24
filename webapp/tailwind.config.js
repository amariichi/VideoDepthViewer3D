/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            colors: {
                tropical: {
                    bg: '#fdfbf7',       // Warm Sand
                    surface: '#ffffff',  // White
                    primary: '#00897b',  // Teal
                    accent: '#ff8a65',   // Coral
                    pink: '#e4007c',     // Mexican Pink
                    text: '#263238',     // Dark Blue Grey
                    muted: '#546e7a',    // Muted Blue Grey
                }
            },
            fontFamily: {
                sans: ['Inter', 'system-ui', 'sans-serif'],
            }
        },
    },
    plugins: [],
}
