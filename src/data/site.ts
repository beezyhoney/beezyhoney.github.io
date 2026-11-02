export const SITE = {
  name: 'Beezy Honey',
  farm: 'Abinash Honey Farming',
  established: 2017,
  tagline: 'Nature’s finest luxury',
  phoneDisplay: '+91 63832 71931',
  phoneTel: '+916383271931',
  whatsapp: '916383271931',
  instagram: 'beezy_honey__',
  instagramUrl: 'https://www.instagram.com/beezy_honey__/',
  fssai: '22425032000995',
};

/** Prefix a site path with the GitHub Pages base path. `link('/shop/')` → `/beezyhoney/shop/` */
export const link = (path: string) => import.meta.env.BASE_URL.replace(/\/$/, '') + path;

/** WhatsApp chat link with a pre-filled message */
export const waLink = (text: string) => `https://wa.me/${SITE.whatsapp}?text=${encodeURIComponent(text)}`;

export const WA_MESSAGES = {
  general: 'Hi Beezy Honey! I have a question about your honey.',
  visit: 'Hi Beezy Honey! I’d like to book a farm visit & honey tasting.\nNumber of people: \nPreferred date: ',
  gifts: 'Hi Beezy Honey! I’m looking for honey gifts / return gifts.\nOccasion: \nQuantity: \nDate needed: ',
  bulk: 'Hi Beezy Honey! I’d like to place a bulk / corporate order.\nProducts: \nQuantity: \nCity: ',
};
