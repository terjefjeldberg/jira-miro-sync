import { text } from './auth.js';

export function renderCommentsClient() {
  const script = String.raw`(async function () {
const root=document.getElementById('comments');
const title=document.getElementById('title');
const list=document.getElementById('list');
const form=document.getElementById('form');
const input=document.getElementById('input');
const message=document.getElementById('message');
const submit=document.getElementById('submit');
const data=await miro.board.ui.getModalData();
const query=new URLSearchParams(window.location.search);
const issueKey=String(data&&data.issueKey||query.get('issueKey')||'').trim().toUpperCase();
const itemId=String(data&&data.itemId||query.get('itemId')||'').trim();
title.textContent=issueKey ? 'Comments · '+issueKey : 'Comments';
const showMessage=(value,error=false)=>{message.textContent=value||'';message.className=error?'error':''};
const appendNode=async(parent,node,token)=>{
  if(!node)return;
  if(typeof node==='string'){parent.append(document.createTextNode(node));return}
  if(node.type==='text'){parent.append(document.createTextNode(String(node.text||'')));return}
  if(node.type==='hardBreak'){parent.append(document.createElement('br'));return}
  if(node.type==='media'){
    const attrs=node.attrs||{};
    const attachmentId=String(attrs.id||'').trim();
    const alt=String(attrs.alt||'Jira attachment');
    if(!attachmentId){parent.append(document.createTextNode(alt));return}
    const image=document.createElement('img');image.className='comment-image';image.alt=alt;image.title=alt;
    try{
      const response=await fetch('/jira-comment-media?issueKey='+encodeURIComponent(issueKey)+'&itemId='+encodeURIComponent(itemId)+'&attachmentId='+encodeURIComponent(attachmentId),{headers:{Authorization:'Bearer '+token}});
      if(!response.ok)throw new Error('Attachment request failed');
      image.src=URL.createObjectURL(await response.blob());
      parent.append(image);
    }catch(error){parent.append(document.createTextNode(alt+' (image unavailable)'));}
    return;
  }
  if(node.type==='mention'){parent.append(document.createTextNode(String(node.attrs&&node.attrs.text||'')));return}
  if(node.type==='inlineCard'){parent.append(document.createTextNode(String(node.attrs&&node.attrs.url||'')));return}
  const block=node.type==='paragraph'||node.type==='heading'||node.type==='blockquote'||node.type==='mediaSingle';
  const target=block?document.createElement(node.type==='heading'?'div':'div'):parent;
  if(block){target.className=node.type==='mediaSingle'?'comment-media':'comment-block';parent.append(target)}
  for(const child of node.content||[])await appendNode(target,child,token);
};
const appendBody=async(parent,body,token)=>{for(const node of body&&body.content||[])await appendNode(parent,node,token)};
const appendRenderedHtml=async(parent,html,token)=>{
  const parsed=new DOMParser().parseFromString(String(html||''),'text/html');
  const appendElement=async(target,element)=>{
    if(element.nodeType===Node.TEXT_NODE){target.append(document.createTextNode(element.nodeValue||''));return}
    if(element.nodeType!==Node.ELEMENT_NODE)return;
    const tag=element.tagName.toLowerCase();
    if(tag==='br'){target.append(document.createElement('br'));return}
    if(tag==='img'){
      const source=String(element.getAttribute('src')||'');
      const match=source.match(/\/attachment\/(?:content|thumbnail)\/(\d+)/i);
      const alt=String(element.getAttribute('alt')||'Jira attachment');
      if(!match){target.append(document.createTextNode(alt));return}
      const image=document.createElement('img');image.className='comment-image';image.alt=alt;image.title=alt;
      try{
        const response=await fetch('/jira-comment-media?issueKey='+encodeURIComponent(issueKey)+'&itemId='+encodeURIComponent(itemId)+'&attachmentId='+encodeURIComponent(match[1]),{headers:{Authorization:'Bearer '+token}});
        if(!response.ok)throw new Error('Attachment request failed');
        image.src=URL.createObjectURL(await response.blob());target.append(image);
      }catch(error){target.append(document.createTextNode(alt+' (image unavailable)'));}
      return;
    }
    const allowed={p:'div',div:'div',span:'span',strong:'strong',b:'strong',em:'em',i:'em',del:'del',s:'s',ul:'ul',ol:'ol',li:'li',blockquote:'blockquote',code:'code',pre:'pre'};
    const safeTag=allowed[tag];
    if(!safeTag){for(const child of element.childNodes)await appendElement(target,child);return}
    const childTarget=document.createElement(safeTag);
    if(tag==='p'||tag==='div'||tag==='blockquote')childTarget.className='comment-block';
    target.append(childTarget);
    for(const child of element.childNodes)await appendElement(childTarget,child);
  };
  for(const child of parsed.body.childNodes)await appendElement(parent,child);
};
async function currentMiroUserName(){try{const token=await miro.board.getIdToken();const part=String(token||'').split('.')[1];if(part){const payload=JSON.parse(atob(part.replace(/-/g,'+').replace(/_/g,'/')));const name=payload.name||payload.display_name||payload.displayName||payload.preferred_username||payload.nickname||payload.username;if(String(name||'').trim())return String(name).trim()}}catch(error){console.warn('Could not read Miro user name from identity token',error)}return 'Miro user'}
const render=async(comments,token)=>{
  list.replaceChildren();
  if(!comments.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='No comments yet.';list.append(empty);return}
  for(const comment of comments){
    const article=document.createElement('article');
    const header=document.createElement('header');
    const author=document.createElement('strong');author.textContent=comment.author||'Unknown user';
    const date=document.createElement('time');date.textContent=comment.created?new Date(comment.created).toLocaleString():'';
    header.append(author,date);
    const body=document.createElement('div');body.className='comment-body';
    if(comment.renderedBody)await appendRenderedHtml(body,comment.renderedBody,token);else await appendBody(body,comment.body,token);
    article.append(header,body);list.append(article);
  }
  list.scrollTop=list.scrollHeight;
};
const load=async()=>{
  if(!issueKey||!itemId){showMessage('This comment control is not linked to a verified custom card.',true);return}
  const token=await miro.board.getIdToken();
  const response=await fetch('/jira-comments?issueKey='+encodeURIComponent(issueKey)+'&itemId='+encodeURIComponent(itemId),{headers:{Authorization:'Bearer '+token}});
  const result=await response.json().catch(()=>null);
  if(!response.ok||!result||!result.ok){showMessage(result&&result.reason||'Could not load Jira comments.',true);return}
  await render(result.comments||[],token);
};
form.addEventListener('submit',async event=>{
  event.preventDefault();
  const comment=input.value.trim();if(!comment)return;
  const author=await currentMiroUserName();
  const jiraComment=author+' via Miro:\n\n'+comment;
  submit.disabled=true;showMessage('Sending…');
  try{
    const token=await miro.board.getIdToken();
    const response=await fetch('/jira-comments',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({issueKey,itemId,comment:jiraComment})});
    const result=await response.json().catch(()=>null);
    if(!response.ok||!result||!result.ok)throw new Error(result&&result.reason||'Could not add Jira comment.');
    input.value='';showMessage('Comment added.');await load();
  }catch(error){showMessage(error.message||String(error),true)}finally{submit.disabled=false}
});
await load();
})();`;
  return text(script, 'application/javascript; charset=utf-8');
}
