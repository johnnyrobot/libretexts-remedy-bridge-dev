// Test evidence only: retain a finite stderr tail and print only fixed hold events.
export function collectDiagnostics(stream){
 let text='';stream.on('data',chunk=>text=(text+chunk).slice(-8192));
 return{text:()=>text,holds:()=>text.split('\n').filter(line=>line.startsWith('{"event":"renderer_admission_hold"')).slice(-4).join('\n')};
}
