'use strict';
const params = new URLSearchParams(window.location.search);
document.documentElement.lang = params.get('locale') || 'en';
const guide = document.querySelector('.layout-guide');
if (params.get('hint')) guide.textContent = params.get('hint');
if (params.get('font')) guide.style.fontFamily = params.get('font');
