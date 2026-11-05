'use strict';

// Small self-contained line icons. Do not depend on the host's icon registry,
// external fonts, network assets or theme-provided SVG stroke defaults.
const PATHS={
 'table-2':['M3 3h18v18H3Z','M3 9h18M9 3v18'],
 scan:['M9 3H3v6m12-6h6v6M3 15v6h6m6 0h6v-6'],
 check:['M4 12l5 5L20 6'],
 'table-properties':['M3 3h18v18H3Z','M3 9h18M3 15h18M9 3v18','M15 4v3m0 3v3m0 3v3'],
 combine:['M3 4h6m6 0h6v16h-6M9 20H3V4','M3 12h7m-3-3 3 3-3 3m14-3h-7m3-3-3 3 3 3'],
 split:['M3 4h18v16H3Z','M12 4v16M10 12H5m3-3-3 3 3 3m6-3h5m-3-3 3 3-3 3'],
 'align-left':['M3 3v18M6 6h15M6 10h10M6 14h15M6 18h10'],
 'align-center':['M3 5h18M7 10h10M3 15h18M7 20h10'],
 'align-right':['M21 3v18M3 6h15M8 10h10M3 14h15M8 18h10'],
 'align-vertical-justify-start':['M3 3h18M6 7v14M12 7v9M18 7v14'],
 'align-vertical-justify-center':['M3 12h18M6 3v7m0 4v7M12 6v4m0 4v4M18 3v7m0 4v7'],
 'align-vertical-justify-end':['M3 21h18M6 3v14M12 8v9M18 3v14'],
 'arrow-up-to-line':['M3 3h18M12 21V7m-5 5 5-5 5 5'],
 'arrow-down-to-line':['M3 21h18M12 3v14m-5-5 5 5 5-5'],
 'arrow-left-to-line':['M3 3v18M21 12H7m5-5-5 5 5 5'],
 'arrow-right-to-line':['M21 3v18M3 12h14m-5-5 5 5-5 5'],
 eraser:['m3 14 10-11 8 8-9 10H9Z','m7 10 8 8M12 21h9'],
 'rows-3':['M3 3h18v18H3Z','M3 9h18M3 15h18'],
 'columns-3':['M3 3h18v18H3Z','M9 3v18M15 3v18'],
 pin:['M8 3h8m-7 0v6l-4 5h14l-4-5V3M12 14v8'],
 palette:['M12 3a9 9 0 1 0 0 18c2 0 3-1 2-3-1-2 0-3 2-3h2c2 0 3-2 3-4a9 9 0 0 0-9-8Z','M7 9h.1M11 6h.1M16 7h.1M6 14h.1'],
 copy:['M8 8h13v13H8Z','M16 8V3H3v13h5'],
 'undo-2':['M8 4 3 9l5 5M3 9h11a7 7 0 0 1 0 14'],
 'redo-2':['m16 4 5 5-5 5m5-5H10a7 7 0 0 0 0 14'],
 ellipsis:['M4 12h1m6 0h1m6 0h1'],
 'settings-2':['M3 6h8m4 0h6M3 12h2m4 0h12M3 18h12m4 0h2','M11 3v6M5 9v6m10 0v6'],
 x:['m5 5 14 14M19 5 5 19'],
 pencil:['m4 16 12-12 4 4L8 20H4Z','m13 7 4 4']
};

function renderIcon(element,name){
 const doc=element.ownerDocument,ns='http://www.w3.org/2000/svg';
 const svg=doc.createElementNS(ns,'svg');
 for(const [key,value]of Object.entries({xmlns:ns,viewBox:'0 0 24 24',width:'18',height:'18',fill:'none',stroke:'currentColor','stroke-width':'1.8','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',focusable:'false',class:'tt-icon'}))svg.setAttribute(key,value);
 // Inline presentation also covers hosts that reset generic button SVGs.
 for(const [key,value]of Object.entries({display:'block',visibility:'visible',opacity:'1',width:'18px',height:'18px',stroke:'currentColor','stroke-width':'1.8',fill:'none','flex-shrink':'0'}))svg.style.setProperty(key,value,'important');
 for(const d of PATHS[name]||PATHS['table-2']){
  const path=doc.createElementNS(ns,'path');path.setAttribute('d',d);path.style.setProperty('stroke','inherit','important');path.style.setProperty('fill','none','important');svg.appendChild(path);
 }
 element.replaceChildren(svg);return svg;
}

module.exports={renderIcon,PATHS};
