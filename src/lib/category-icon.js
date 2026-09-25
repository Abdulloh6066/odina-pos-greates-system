// Shared category icon for the Odina POS picker.
// Category.icon is a string: either an emoji glyph or an image URL.

export const TEA_ICON_URL =
  'https://media.base44.com/images/public/6a96eb22a9fd2b34081eb2dd/91da38d28_image.png';

export const APELSIN_ICON_URL =
  'https://media.base44.com/images/public/6a96eb22a9fd2b34081eb2dd/b71c8f89b_ECD870ED-880E-49C7-AAFB-8C60497719C5.png';

export const SMOOTHIE_ICON_URL =
  'https://media.base44.com/images/public/6a96eb22a9fd2b34081eb2dd/ba969de6a_FE3F8B54-1F45-4341-8F92-88F0C0B53360.png';

export const MILKSHAKE_ICON_URL =
  'https://media.base44.com/images/public/6a96eb22a9fd2b34081eb2dd/d02592059_7D154F5A-75EF-4460-AADD-C0DAA4EC7904.png';

export const isImageIcon = (icon) =>
  typeof icon === 'string' && icon.startsWith('http');