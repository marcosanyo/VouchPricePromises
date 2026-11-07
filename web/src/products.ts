// Generic illustrations (Nano Banana 2.1, no brands or logos) for the product
// categories shown in the demo shop. Names stay anonymised ("Category · #Code");
// categories without an illustration show a drawn bag icon (ProductArt).
const IMAGES: Record<string, string> = {
  'Over-Ear Headphones': '/products/over-ear-headphones.png',
  Sandals: '/products/sandals.png',
  'Portable Bluetooth Speakers': '/products/portable-bluetooth-speakers.png',
  'Water Bottles': '/products/water-bottles.png',
  'Mirrorless Digital Cameras': '/products/mirrorless-cameras.png',
  'Home Game Consoles': '/products/home-game-consoles.png',
  'Stand Mixers': '/products/stand-mixers.png',
  'Massage Guns': '/products/massage-guns.png',
  'Video Game Console Accessories': '/products/video-game-console-accessories.png',
  Sneakers: '/products/sneakers.png',
  'Espresso Machines': '/products/espresso-machines.png',
};

export function productImage(title: string | undefined): string | null {
  if (!title) return null;
  return IMAGES[title.split(' · ')[0]] ?? null;
}
