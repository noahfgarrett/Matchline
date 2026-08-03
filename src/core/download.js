export function saveBlob(blob,filename,mimeType){
  const out=mimeType?new Blob([blob],{type:mimeType}):blob,url=URL.createObjectURL(out),a=document.createElement('a');
  a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1500);
}
export async function saveUpdateHtml(htmlBlob,filename){saveBlob(htmlBlob,filename,'text/html');}
export function downloadBlob(filename,blob){saveBlob(blob,filename);}
