/* University Parking — the ONE list of vehicle manufacturers and models.
 *
 * The browser loads this file (window.VehicleCatalog) to drive the Manufacturer / Model pickers on My Vehicles; Node
 * require()s the very same file (src/services/users.js) to validate what is submitted. Manufacturers depend on the vehicle
 * type (car or motorcycle; vans and SUVs are registered as cars) and models depend on the manufacturer.
 *
 * Extend the lists freely. Anything not listed can be entered by choosing Other (the OTHER value) and typing it.
 * Vehicles saved before this list existed keep their stored make/model and stay editable.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VehicleCatalog = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CATALOG = {
    car: {
      Audi: ['A3', 'A4', 'A6', 'Q3', 'Q5', 'Q7'],
      BMW: ['1 Series', '3 Series', '5 Series', 'X1', 'X3', 'X5'],
      BYD: ['Atto 3', 'Dolphin', 'Han', 'Seal', 'Sealion 6'],
      Chery: ['Tiggo 2 Pro', 'Tiggo 5x', 'Tiggo 7 Pro', 'Tiggo 8 Pro'],
      Chevrolet: ['Colorado', 'Cruze', 'Sail', 'Spark', 'Suburban', 'Tahoe', 'Tracker', 'Trailblazer'],
      Ford: ['EcoSport', 'Everest', 'Explorer', 'Mustang', 'Ranger', 'Territory', 'Transit'],
      Foton: ['Gratour', 'Toplander', 'View Traveller'],
      Geely: ['Azkarra', 'Coolray', 'Emgrand', 'Okavango'],
      Honda: ['Accord', 'Brio', 'BR-V', 'City', 'Civic', 'CR-V', 'HR-V', 'Jazz'],
      Hyundai: ['Accent', 'Creta', 'Elantra', 'Ioniq 5', 'Palisade', 'Reina', 'Santa Fe', 'Starex', 'Stargazer', 'Staria', 'Tucson'],
      Isuzu: ['D-Max', 'mu-X', 'Traviz'],
      Kia: ['Carnival', 'EV6', 'Picanto', 'Rio', 'Seltos', 'Soluto', 'Sorento', 'Sportage', 'Stonic'],
      Lexus: ['ES', 'IS', 'LX', 'NX', 'RX'],
      Mazda: ['BT-50', 'CX-3', 'CX-30', 'CX-5', 'CX-9', 'Mazda2', 'Mazda3', 'Mazda6', 'MX-5'],
      'Mercedes-Benz': ['A-Class', 'C-Class', 'E-Class', 'GLA', 'GLC', 'GLE'],
      MG: ['MG 5', 'MG HS', 'MG RX5', 'MG ZS'],
      Mitsubishi: ['L300', 'Mirage', 'Mirage G4', 'Montero Sport', 'Outlander', 'Strada', 'Xpander'],
      Nissan: ['Almera', 'Kicks', 'Leaf', 'Navara', 'NV350 Urvan', 'Patrol', 'Sylphy', 'Terra', 'Urvan'],
      Subaru: ['BRZ', 'Forester', 'Impreza', 'Outback', 'WRX', 'XV'],
      Suzuki: ['APV', 'Celerio', 'Dzire', 'Ertiga', 'Jimny', 'S-Presso', 'Swift', 'Vitara', 'XL7'],
      Tesla: ['Model 3', 'Model S', 'Model X', 'Model Y'],
      Toyota: ['Alphard', 'Avanza', 'Camry', 'Corolla Altis', 'Corolla Cross', 'Fortuner', 'GR86', 'Hiace', 'Hiace Commuter', 'Hilux', 'Innova', 'Land Cruiser', 'Raize', 'Rush', 'Veloz', 'Vios', 'Wigo', 'Yaris'],
      Volkswagen: ['Lamando', 'Lavida', 'Santana', 'T-Cross', 'Tiguan'],
    },
    motorcycle: {
      'BMW Motorrad': ['G 310 GS', 'G 310 R', 'R 1250 GS'],
      Ducati: ['Monster', 'Multistrada V2', 'Panigale V2', 'Scrambler Icon'],
      'Harley-Davidson': ['Fat Boy', 'Nightster', 'Sportster S', 'Street Glide'],
      Honda: ['ADV160', 'Airblade 160', 'BeAT', 'Click 125', 'Click 160', 'CRF150L', 'PCX160', 'TMX125 Alpha', 'Wave RSX', 'XRM125'],
      Kawasaki: ['Barako II', 'Dominar 400', 'KLX150', 'Ninja 400', 'Rouser NS160', 'W175', 'Z400'],
      Kymco: ['Like 150i', 'Xciting S400'],
      'Royal Enfield': ['Classic 350', 'Himalayan', 'Hunter 350', 'Interceptor 650', 'Meteor 350'],
      Suzuki: ['Burgman Street', 'Gixxer', 'GSX-R150', 'Raider R150', 'Skydrive Sport', 'Smash 115'],
      TVS: ['Apache RTR 200', 'Dazz', 'XL100'],
      Vespa: ['GTS 300', 'LX 125', 'Primavera', 'Sprint'],
      Yamaha: ['Aerox', 'FZi', 'Mio Gear', 'Mio i 125', 'Mio Sporty', 'MT-15', 'NMAX', 'R15', 'Sniper 155', 'XMAX', 'XSR155', 'YTX 125'],
    },
  };

  var key = function (s) { return String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase(); };

  /** Manufacturers offered for a vehicle type, alphabetical. */
  function manufacturers(type) {
    return Object.keys(CATALOG[type] || {}).sort(function (a, b) { return a.localeCompare(b); });
  }

  /** Models offered for a manufacturer of a vehicle type, alphabetical (empty when the pair is unknown). */
  function models(type, manufacturer) {
    var name = findManufacturer(type, manufacturer);
    return name ? CATALOG[type][name].slice().sort(function (a, b) { return a.localeCompare(b); }) : [];
  }

  /** The catalogue spelling of a manufacturer (case and spacing insensitive), or null. */
  function findManufacturer(type, value) {
    var k = key(value);
    var list = manufacturers(type);
    for (var i = 0; i < list.length; i++) if (key(list[i]) === k) return list[i];
    return null;
  }

  /** The catalogue spelling of a model for that manufacturer, or null. */
  function findModel(type, manufacturer, value) {
    var name = findManufacturer(type, manufacturer);
    if (!name) return null;
    var k = key(value);
    var list = CATALOG[type][name];
    for (var i = 0; i < list.length; i++) if (key(list[i]) === k) return list[i];
    return null;
  }

  /** Value of the "Other" choice in the Manufacturer and Model dropdowns: the name is then typed in. */
  var OTHER = '__other__';

  return { CATALOG: CATALOG, OTHER: OTHER, manufacturers: manufacturers, models: models, findManufacturer: findManufacturer, findModel: findModel, key: key };
});
