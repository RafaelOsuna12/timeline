#!/usr/bin/env node
/** Genera un par de claves VAPID (las apps ya lo hacen automáticamente al crearse). */
import webpush from 'web-push';
const keys = webpush.generateVAPIDKeys();
console.log('VAPID_PUBLIC_KEY=%s', keys.publicKey);
console.log('VAPID_PRIVATE_KEY=%s', keys.privateKey);
