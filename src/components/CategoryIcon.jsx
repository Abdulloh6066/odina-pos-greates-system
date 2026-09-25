import React from 'react';
import { isImageIcon } from '@/lib/category-icon';

/**
 * Renders a category icon which may be an emoji glyph or an image URL.
 */
export default function CategoryIcon({ icon, fallback = '🍰', className = '', imgClassName = '' }) {
  const value = icon || fallback;
  if (isImageIcon(value)) {
    return <img src={value} alt="" className={`object-contain ${imgClassName}`} />;
  }
  return <span className={className}>{value}</span>;
}