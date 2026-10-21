# Lightbox UI evidence for PR #6212

Existing repository Storybook fixture: Product / Attachments / Image Thumbnails; click dashboard.png. Captured in Chrome on macOS at 1456 x 849, light renderer theme and Simplified Chinese locale, using the direct Storybook iframe.

- before.png: base/parent ff74d21c8f1e2904bb85a00b3ffef98c7834792c. The existing Storybook catalog was temporarily limited to attachment.stories.tsx to complete the repository build; fixture, renderer code, theme and CSS were unchanged. The original catalog configuration was restored and verified byte-for-byte afterward.
- after.png: PR head bba94e7fa88a56748ea85d74bebe67684337723c, using its previously successful complete Storybook build. The compiled CSS includes the new close-button inset rule.

Both show the ordinary browser / zero Window Controls Overlay inset path; unchanged spacing is expected. These screenshots do not reproduce or validate native Windows caption-button overlap. Original Windows native overlay verification remains unperformed. No injected CSS, invented fixture or image editing was used.

Captured by Codex using the browser screenshot API. Fixture images and UI originate from apache/maka, Apache-2.0; repository licenses and notices are preserved on this branch.
