# 🎬 PROJECT PRD & CLAUDE CODE INSTRUCTIONS: Cinematic Portfolio

## 1. Project Overview & End Goal
The objective is to build a top-tier, ultra-premium portfolio website for a graphics designer, video editor, and director. 
This is not a traditional website. It is a **continuous, interactive 3D cinematic flight** driven entirely by the user's scroll. As the user scrolls down, they scrub forward through a rendered image sequence; scrolling up scrubs backward. 

**Target Audience:** High-end ad agencies, production houses, and clients within the dynamic Indian creative and advertising market. The aesthetic must reflect modern cinematic standards—dark, moody, and highly polished.
**Cost Constraint:** The entire tech stack must remain 100% free to build and free to host. No paid premium animation plugins.

## 2. Quality Standards & Aesthetic
*   **Vibe:** Dark, moody, and cinematic. Think dimly lit studio, heavy shadows, and dramatic rim lighting. 
*   **Colors:** Pitch black background (`#000000`), stark white (`#FFFFFF`) typography, with subtle cinematic glowing accents. 
*   **Textures:** Apply a subtle CSS noise filter over the viewport to mimic analog film grain.
*   **Typography:** Ultra-clean sans-serif fonts reminiscent of high-end movie credits (e.g., Inter, Helvetica Now, or a customized Google Font). 
*   **Performance:** Butter-smooth 60fps scrolling on both desktop and mobile networks across India. No jittering during canvas updates.

## 3. Tech Stack & Architectural Map
The stack relies entirely on open-source, native-first solutions.
*   **Framework:** Astro (Zero-JS delivery by default). The UI must remain incredibly lean.
*   **Scroll Mechanics:** Lenis (for fluid, heavy scroll momentum).
*   **Animations:** Anime.js (for staggering DOM reveals and drawing SVG paths).
*   **Visual Engine:** HTML5 `<canvas>` rendering WebP image sequences on scroll.

### 4. Claude Code Skill/Plugin Usage
You have access to specific plugins. Apply them strictly under these conditions:
*   **When to use `ponytail`:** Trigger this skill continuously during scaffolding and component creation to enforce strict code minimalism. Use it to strip away unnecessary abstractions, avoid bloat, and ensure we are using native Browser APIs (like IntersectionObserver) wherever possible before adding third-party logic.
*   **When to use `scroll-world`:** Invoke this skill specifically when wiring up the core scroll controller and `<canvas>` scrubbing engine. Use it to handle the complex math of mapping Lenis scroll progress (0.0 to 1.0) to the precise frame index of the image sequence, ensuring no frame-skipping or memory leaks.
    *   **Scope note:** The upstream `scroll-world` plugin is primarily a *content-generation* pipeline (Higgsfield/Codex image + camera-flight gen, paid credits) for isometric diorama scenes — that pipeline is **not used here**, since it conflicts with the 100% free / ComfyUI-local asset plan in Section 5. We only borrow its portable `scrub-engine.js` (blob-seek, lazy-load, seam-crossfade logic) as the frame-index-mapping core, adapted to our Lenis progress → WebP frame lookup. Do not run the skill's interview/generation flow.

## 5. Asset Specifications (The Video Narrative)
The core visual is a continuous 3D camera flight rendered as an image sequence. To keep this completely free, the rendering of these 300-450 frames will be handled locally using ComfyUI or similar local generative models leveraging the 24GB unified memory Mac setup, completely avoiding paid API credits.

*   **Format:** `.webp` at 80% compression. Total directory size must remain under 15MB.
*   **Responsive Deliverables:** 
    *   Desktop Sequence: `1920x1080` (Landscape).
    *   Mobile Sequence: `1080x1920` (Portrait - specifically framed for vertical screens, not just cropped).
*   **Asset Loading:** The `<canvas>` script must detect `window.innerWidth` on load and request the appropriate sequence directory.

## 6. Timeline & Scene Choreography
The central Lenis scroll controller acts as a master timeline. The user's scroll depth from 0% to 100% of the document height controls both the frame index of the `<canvas>` (Z-index: 0) and the position/opacity of the UI elements (Z-index: 10).

*   **Scene 1: The Setup (0% - 25% Scroll)**
    *   *Visual:* Close-up macro shot of a vintage movie lens, panning back slowly to reveal a moody, dimly lit studio environment.
    *   *UI Overlay:* Main title/Intro. Big, bold typography. 
*   **Scene 2: The Director (25% - 50% Scroll)**
    *   *Visual:* The camera orbits continuously around an animated character representing the director, who is looking through a viewfinder or adjusting a cinematic lighting rig.
    *   *UI Overlay:* "Directing" section. Anime.js triggers a staggered blur-to-sharp reveal of text detailing his vision and directing experience. Thin SVG lines draw themselves onto the screen, connecting UI text to the physical 3D rig in the background.
*   **Scene 3: The Edit Bay (50% - 75% Scroll)**
    *   *Visual:* The camera swoops dramatically over the character's shoulder, focusing on a dark editing bay with glowing monitors. 
    *   *UI Overlay:* "Motion Graphics & Editing" section. As the monitors come into view on the canvas, the UI layer reveals his actual portfolio samples/links, floating alongside the screens.
*   **Scene 4: The Fade Out (75% - 100% Scroll)**
    *   *Visual:* The camera pulls far back into the shadows of the studio, leaving only a single, dramatic spotlight.
    *   *UI Overlay:* Contact section. The spotlight aligns perfectly with the final call-to-action and contact links. 

## 7. Mandatory UX Interactions (Inspired by References)
1.  **The Cinematic Pre-loader (Organimo Style):** 
    *   Because we must load ~300 WebP images, the site *must not* allow the user to scroll immediately. 
    *   Build a full-screen, dark loading state (e.g., a glowing focus ring or a clapperboard loader) that updates based on the percentage of frames cached in the browser. 
    *   Once 100% loaded, the pre-loader fades out, and the scroll is unlocked.
2.  **Staggered Typography (Oryzo Style):**
    *   Do not use basic CSS fades. As sections enter the viewport, split the text into words/characters and use Anime.js to reveal them with a slight upward translation and a blur filter fading to 0px.
3.  **Data Tracing (Anime.js Style):**
    *   In Scenes 2 and 3, utilize Anime.js SVG path drawing capabilities to create high-tech, glowing lines that animate from the edge of the screen and point to specific elements in the `<canvas>` background.

## 8. Implementation Order for Claude Code
1.  **Phase 1:** Scaffold Astro project. Apply `ponytail` for extreme cleanup of the default boilerplate. Set up global CSS variables (black, white, fonts).
2.  **Phase 2:** Build the Pre-loader component and the WebP caching script. 
3.  **Phase 3:** Implement Lenis smooth scroll globally.
4.  **Phase 4:** Invoke `scroll-world` to build the `<canvas>` component. Wire Lenis progress to the canvas `drawImage` function. Implement the resize listener to toggle between desktop and mobile frame folders.
5.  **Phase 5:** Build the 4 HTML `<section>` blocks (height: `100vh`, spaced by empty spacer divs to create scroll length). 
6.  **Phase 6:** Integrate Anime.js Scroll Observers to handle the typography reveals and SVG animations for the foreground UI. Ensure zero conflict with the canvas rendering cycle.
