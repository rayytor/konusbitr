# Konusbitr — Design Specification

## 1. Design Direction

Konusbitr should have a **minimal, editorial, calm, document-first interface**.

The visual language should feel closer to a refined reading/writing tool than a conventional SaaS dashboard. The PDF and its content are the primary focus; UI elements should support the document rather than compete with it.

### Core principles

- Minimal visual noise.
- Strong typography and whitespace.
- Warm, paper-like surfaces.
- Clear hierarchy without excessive cards, borders, or shadows.
- Icons should be preferred over decorative graphics or emoji.
- Interactions should feel quiet, deliberate, and responsive.
- Avoid unnecessary gradients, glassmorphism, excessive rounded corners, and heavy shadows.
- The interface must remain highly usable at smaller screen sizes.
- Accessibility and readability take priority over visual novelty.

---

## 2. Typography

### Primary UI font

Use **LINE Seed JP** for all normal interface text.

Google Fonts:
- Family: `LINE Seed JP`

Use it for:

- Body text
- Navigation
- Buttons
- Labels
- Inputs
- Metadata
- Tooltips
- Chat messages
- Document names
- Settings
- Tables
- Empty states

### Display / heading font

Use **Instrument Serif** for headings and editorial display text.

Google Fonts:
- Family: `Instrument Serif`

Use it for:

- Page titles
- Large section headings
- Empty-state headings
- Important document titles
- Marketing/landing-page headlines
- Major modal titles when appropriate

Do **not** use Instrument Serif for small UI labels, buttons, navigation, or dense metadata.

### Typography hierarchy

The hierarchy should primarily come from:

1. Font family
2. Font size
3. Weight
4. Whitespace
5. Subtle color differences

Avoid relying heavily on uppercase text, excessive bolding, or decorative treatments.

Suggested scale:

| Element | Font | Approx. size |
|---|---|---:|
| Hero title | Instrument Serif | 48–64px |
| Page title | Instrument Serif | 32–42px |
| Section heading | Instrument Serif | 24–30px |
| Card/dialog heading | Instrument Serif | 20–24px |
| Body | LINE Seed JP | 15–17px |
| Small body | LINE Seed JP | 13–14px |
| Metadata | LINE Seed JP | 12–13px |
| Button | LINE Seed JP | 14px |

Line height should be generous for reading-heavy content.

---

## 3. Default Theme — Sepia Light

The default theme must be **sepia light**, resembling warm archival paper rather than a pure white web page.

### Suggested color tokens

These are starting points, not rigid values. Maintain consistent contrast and adjust individual values if accessibility testing requires it.

```css
:root {
  --background: #F5F0E6;
  --surface: #FBF8F0;
  --surface-muted: #EEE7D9;

  --foreground: #29251F;
  --foreground-muted: #70695D;
  --foreground-subtle: #958D80;

  --border: #D8D0C2;
  --border-subtle: #E5DED1;

  --primary: #29251F;
  --primary-foreground: #FBF8F0;

  --accent: #8A6545;
  --accent-muted: #E7D9C7;

  --success: #5F7058;
  --warning: #9A7443;
  --danger: #9A5149;

  --selection: #E5D5B9;
}
```

### Theme behavior

- The sepia light theme is the default on first launch.
- Do not make the interface pure white by default.
- Dark mode may be provided as an alternative theme.
- Theme switching should be available from settings.
- Theme transitions should be subtle and short.
- Never use color alone to communicate an important state.

---

## 4. Overall Layout

The application should use a restrained application shell.

### Desktop

Use three logical regions when viewing a document:

```text
┌───────────────────────────────────────────────────────────────┐
│ Top bar                                                       │
├──────────────┬──────────────────────────────┬─────────────────┤
│              │                              │                 │
│ Document     │          PDF Viewer           │      Chat       │
│ navigation   │                              │                 │
│              │                              │                 │
│              │                              │                 │
└──────────────┴──────────────────────────────┴─────────────────┘
```

The exact proportions may adapt to viewport size, but the PDF should remain the visual center of the experience.

### Navigation

The navigation/sidebar should be:

- Narrow.
- Quiet.
- Easy to collapse.
- Icon-led.
- Clearly labeled when expanded.
- Free of unnecessary decorative elements.

Primary navigation may include:

- Library
- Recent documents
- Folders
- Conversations
- Settings

Use icons alongside labels. Avoid emoji.

---

## 5. Document Library

The library should feel like a digital bookshelf/file cabinet rather than a generic admin dashboard.

### Layout

Prefer:

- Spacious list views.
- Optional compact grid view.
- Clear document names.
- Small metadata.
- Subtle dividers.
- Strong whitespace.

Avoid:

- Large colorful cards.
- Excessive shadows.
- Huge thumbnails.
- Dense dashboard widgets.

### Document item

A document row should communicate:

- PDF/document icon
- Filename
- Page count
- Last opened/updated information
- Optional processing status
- Context menu

Use a simple icon for file type rather than a large illustration.

### Actions

Common actions should use recognizable icons:

- Open
- Rename
- Move
- Download/export
- Share
- Delete
- More

Tooltips should appear on icon-only controls.

---

## 6. Upload Experience

Uploading should be extremely simple.

The primary upload area should be visually understated.

Example hierarchy:

```text
Upload a document

Drop a PDF here
or choose a file

[ Upload ]
```

Do not make the upload interface visually dominant with giant illustrations.

Support:

- Drag and drop
- File picker
- URL import when supported
- Multiple files where supported

During processing, show a compact progress state with meaningful stages such as:

- Uploading
- Parsing
- OCR
- Embedding
- Ready

Progress should communicate actual processing state rather than displaying an artificial animation.

---

## 7. PDF Viewer

The PDF viewer is one of the most important parts of the application.

### Principles

- The document should look like a real page.
- Keep controls minimal.
- Preserve generous whitespace around pages.
- Avoid unnecessary UI overlays.
- Make navigation controls discoverable but unobtrusive.

### Viewer controls

Use icons for:

- Previous page
- Next page
- Page number
- Zoom out
- Zoom in
- Fit to width
- Search
- Download
- Fullscreen
- More

### Citation highlighting

When a citation is selected:

1. Navigate to the referenced page.
2. Scroll the relevant content into view.
3. Highlight the referenced bounding box.
4. Use a subtle warm accent rather than a bright neon color.
5. Keep the highlight visible long enough to establish context.
6. Avoid covering the underlying document text.

The highlight should feel integrated with the paper rather than like a floating UI object.

---

## 8. Chat Interface

The chat should feel like a focused reading companion.

### Layout

Prefer a clean vertical conversation with generous spacing.

Avoid:

- Heavy message bubbles.
- Large colored chat cards.
- Excessive avatars.
- Decorative backgrounds.

User and assistant messages should primarily be distinguished through alignment, typography, and subtle surface differences.

### Assistant responses

Assistant answers should prioritize readability.

Use:

- Paragraph spacing
- Headings when needed
- Lists
- Tables where useful
- Inline citations
- Code blocks for technical content

Do not visually overload every response with borders or containers.

### Citations

Citations should appear as compact, recognizable controls.

Example:

```text
Revenue increased substantially during the period. [p. 42]
```

The page reference should be clickable.

Clicking a citation should:

- Focus the PDF viewer on the correct page.
- Highlight the referenced region.
- Preserve the current conversation state.

Use a small page/document icon where helpful.

---

## 9. Chat Composer

The composer should be compact and visually integrated into the page.

It should resemble a refined writing field rather than a large application panel.

Include icons for:

- Attach document
- Add context
- Send
- Stop generation when streaming

The send button should use an icon rather than text where the meaning is unambiguous.

Keyboard interaction should be excellent:

- Enter: send
- Shift + Enter: new line

---

## 10. Buttons

Buttons should be simple and functional.

### Primary button

- Solid dark/warm foreground.
- Warm light text.
- Small to moderate radius.
- No gradient.
- Minimal shadow.

### Secondary button

- Transparent or lightly tinted surface.
- Subtle border.
- Same typography as primary buttons.

### Tertiary button

Use text or an icon with no visible container.

### Destructive actions

Use a restrained danger color and require confirmation for irreversible actions.

Do not use oversized pill-shaped buttons unless the interaction genuinely benefits from that shape.

---

## 11. Icons

**Use icons whenever an icon can communicate an action clearly.**

Preferred icon characteristics:

- Simple
- Monoline or restrained stroke
- Consistent stroke width
- Small visual footprint
- No colorful icon sets

Use icons for:

- Navigation
- File types
- Search
- Upload
- Download
- Share
- Delete
- Rename
- Settings
- Menu
- Close
- Expand/collapse
- Zoom
- Page navigation
- Chat actions
- Citation references

Do not use emoji as interface icons.

If an icon-only control could be ambiguous, provide a tooltip and/or accessible label.

---

## 12. Cards, Borders, and Shadows

The interface should **not be card-heavy**.

### Cards

Use cards only when grouping content genuinely improves comprehension.

Cards should have:

- Subtle background contrast
- Minimal border
- Small or moderate radius
- Little or no shadow

### Borders

Prefer thin, low-contrast borders.

Use borders to establish structure, not decoration.

### Shadows

Use shadows sparingly.

Good uses:

- Dropdowns
- Dialogs
- Floating menus

Avoid shadows on every card, button, input, and section.

---

## 13. Border Radius

Use a restrained radius system.

Suggested tokens:

```css
--radius-sm: 6px;
--radius-md: 10px;
--radius-lg: 14px;
```

Do not make every component excessively rounded.

Document surfaces and the PDF itself may use slightly different radius treatment where appropriate.

---

## 14. Spacing

Whitespace is a major part of the visual identity.

Use a consistent spacing scale.

Suggested base unit:

```text
4px
8px
12px
16px
24px
32px
48px
64px
```

Prefer larger gaps between major sections and smaller gaps between closely related controls.

The interface should feel spacious without wasting screen real estate.

---

## 15. Forms and Inputs

Inputs should be quiet and highly readable.

Use:

- Warm surface backgrounds
- Subtle borders
- Clear focus states
- Comfortable vertical padding
- LINE Seed JP

Avoid:

- Excessively thick borders
- Giant input fields
- Strong gradients
- Decorative placeholders

Focus states must remain clearly visible and accessible.

---

## 16. Dialogs and Menus

Dialogs should be compact and focused.

Structure:

```text
Title
Short explanation

[ Content ]

Secondary action     Primary action
```

Use Instrument Serif for the title and LINE Seed JP for the content/actions.

Menus should use icons where useful, especially for actions such as rename, move, share, export, and delete.

---

## 17. Empty States

Empty states should be editorial and minimal.

Prefer:

```text
Your library is empty

Upload a document to start working with it.

[ Upload document ]
```

Use a small relevant icon if helpful.

Do not use large cartoon illustrations or emoji.

---

## 18. Loading and Processing States

Loading states should communicate progress without creating visual clutter.

Prefer:

- Skeletons for predictable content layouts.
- Small spinners for short actions.
- Progress indicators for document processing.
- Explicit processing stages for long-running jobs.

Avoid excessive pulsing, bouncing, or decorative animation.

---

## 19. Motion

Motion should be subtle.

Use animation for:

- Opening/closing menus
- Dialog transitions
- Sidebar expansion
- Citation focus
- Page navigation feedback
- Streaming state changes

Avoid:

- Large page transitions
- Bouncy animations
- Constant background movement
- Decorative particle effects
- Excessive parallax

Suggested timing:

```css
--motion-fast: 120ms;
--motion-normal: 180ms;
--motion-slow: 280ms;
```

Respect `prefers-reduced-motion`.

---

## 20. Hover Behavior

Hover interactions must remain completely static. **Do not use hover animations.**

### Non-negotiable rule

- Do not animate buttons, links, cards, icons, document rows, navigation items, or other interactive elements on hover.
- Do not use `transform`, scale, movement, sliding, bouncing, fading, rotation, or other animated hover effects.
- Do not introduce decorative hover transitions.
- Hovering an interactive element should only change the cursor from the default cursor to a pointer cursor where appropriate.
- Any visual change that is required for accessibility or state indication must be immediate, not animated.

Example:

```css
.interactive-element {
  cursor: pointer;
}

.interactive-element:hover {
  /* No animation or visual hover effect */
}
```

The interface should feel stable and predictable when the cursor moves across it. Motion is reserved only for the purposeful interface transitions defined in the Motion section.

---

## 21. Responsive Design

The application must remain usable from mobile through large desktop screens.

### Desktop

Use the full document + chat workspace.

### Tablet

Allow:

- Collapsible navigation
- Resizable or stacked viewer/chat panels
- Simplified toolbar

### Mobile

Prioritize one main task at a time.

Recommended structure:

- Library
- Document viewer
- Chat as a separate tab/panel
- Bottom or compact navigation where appropriate

Do not attempt to squeeze the complete desktop three-column interface onto a small screen.

---

## 22. Accessibility

Accessibility is a core design requirement.

The UI should provide:

- Strong text/background contrast
- Visible keyboard focus
- Semantic HTML
- Proper button and form labels
- Screen-reader labels for icon-only controls
- Tooltips for unfamiliar icons
- Keyboard navigation
- Reduced-motion support
- Non-color indicators for status
- Sufficient touch target sizes

Never sacrifice accessibility for minimalism.

---

## 23. Error States

Errors should be calm and actionable.

Instead of:

> Something went wrong!!!

Prefer:

> We couldn't process this document.

Then explain the problem briefly and provide an action:

```text
We couldn't process this PDF because it appears to be encrypted.

[ Try another file ]
```

Use a small warning/error icon where helpful.

---

## 24. Status Indicators

Processing states should use restrained indicators.

Suggested statuses:

- Queued
- Processing
- OCR
- Embedding
- Ready
- Failed

Use both:

- A small icon
- Text

Do not depend on color alone.

---

## 25. Settings

Settings should be organized into clear sections rather than presented as a dense admin dashboard.

Potential sections:

- Appearance
- AI models
- API keys
- Storage
- Account
- Organization
- Billing
- Privacy
- Advanced

Use simple rows with icons, titles, descriptions, and controls.

---

## 26. Landing Page

The landing page should establish the same visual language as the application.

### Visual direction

- Warm sepia background.
- Instrument Serif display typography.
- LINE Seed JP body typography.
- Minimal navigation.
- Strong whitespace.
- Small number of carefully selected UI screenshots.
- Subtle document/PDF visual motifs.
- No excessive gradients.
- No emoji.

The primary message should emphasize:

**Open-source, private document intelligence.**

The design should communicate trust, calmness, openness, and technical quality.

---

## 27. Design Relationship to the Product

The design must reinforce the product's core differentiators described in the implementation plan:

- Document-first workflow
- PDF viewer + chat side-by-side
- Clickable page citations
- Document library
- Self-hosting and privacy
- Local/offline AI capability
- Developer-oriented API

The implementation plan specifically identifies the side-by-side PDF viewer and chat as a core product experience, with citation clicks scrolling the viewer and highlighting the corresponding bounding box. The UI should therefore make the relationship between an answer and its source document immediately understandable. fileciteturn0file0L25-L32

---

## 28. Component Style Summary

| Component | Style |
|---|---|
| Body | LINE Seed JP |
| Headings | Instrument Serif |
| Default theme | Sepia light |
| Background | Warm paper |
| Surfaces | Slightly lighter warm paper |
| Text | Dark warm charcoal |
| Accent | Muted warm brown |
| Borders | Thin and subtle |
| Shadows | Rare and soft |
| Radius | Small/moderate |
| Buttons | Minimal |
| Icons | Preferred |
| Emoji | Never |
| Cards | Use sparingly |
| Animation | Purposeful only; no hover animations |
| PDF | Central visual focus |
| Chat | Clean editorial layout |
| Citations | Compact clickable page references |
| Navigation | Minimal and collapsible |

---

## 29. Non-Negotiable Rules

1. **Instrument Serif is the heading/display font.**
2. **LINE Seed JP is the normal UI/body font.**
3. **Sepia light is the default theme.**
4. **Do not use emoji anywhere in the product UI.**
5. **Use icons whenever an icon clearly communicates an action or object.**
6. **Keep the interface minimal and document-first.**
7. **Avoid unnecessary cards, borders, shadows, gradients, and decorative effects.**
8. **The PDF viewer and chat must feel like one integrated workspace.**
9. **Citations must be visually obvious and directly connected to the PDF.**
10. **Whitespace and typography should provide most of the visual hierarchy.**
11. **Accessibility must not be compromised for visual minimalism.**
12. **Responsive layouts should simplify the interface rather than cram desktop UI into smaller screens.**
13. **Hovering interactive elements must not trigger animations; use only the appropriate pointer cursor.**
14. **All new components must follow the same typography, color, radius, spacing, icon, and motion system.**
