// Shared category icon for the Odina POS picker.
// Category.icon is a string: either an emoji glyph or an image URL.

export const TEA_ICON_URL =
  'https://media.base44.com/images/public/6a96eb22a9fd2b34081eb2dd/91da38d28_image.png';

export const APELSIN_ICON_URL =
  'https://media.base44.com/images/public/6a96eb22a9fd2b34081eb2dd/be9719851_generated_image.png';

export const SMOOTHIE_ICON_URL =
  'https://media.base44.com/images/public/6a96eb22a9fd2b34081eb2dd/1f90d5da2_generated_image.png';

export const MILKSHAKE_ICON_URL =
  'https://media.base44.com/images/public/6a96eb22a9fd2b34081eb2dd/120d3c218_generated_image.png';

export const isImageIcon = (icon) =>
  typeof icon === 'string' && icon.startsWith('http');