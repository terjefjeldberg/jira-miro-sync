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
const plain=node=>{
  if(!node)return '';
  if(typeof node==='string')return node;
  if(node.type==='text')return String(node.text||'');
  const value=(node.content||[]).map(plain).join('');
  return node.type==='paragraph'||node.type==='heading'?value+'\n':value;
};
const showMessage=(value,error=false)=>{message.textContent=value||'';message.className=error?'error':''};
async function currentMiroUserName(){try{const token=await miro.board.getIdToken();const part=String(token||'').split('.')[1];if(part){const payload=JSON.parse(atob(part.replace(/-/g,'+').replace(/_/g,'/')));const name=payload.name||payload.display_name||payload.displayName||payload.preferred_username||payload.nickname||payload.username;if(String(name||'').trim())return String(name).trim()}}catch(error){console.warn('Could not read Miro user name from identity token',error)}return 'Miro user'}
const render=comments=>{
  list.replaceChildren();
  if(!comments.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='No comments yet.';list.append(empty);return}
  for(const comment of comments){
    const article=document.createElement('article');
    const header=document.createElement('header');
    const author=document.createElement('strong');author.textContent=comment.author||'Unknown user';
    const date=document.createElement('time');date.textContent=comment.created?new Date(comment.created).toLocaleString():'';
    header.append(author,date);
    const body=document.createElement('p');body.textContent=plain(comment.body).trim();
    article.append(header,body);list.append(article);
  }
};
const load=async()=>{
  if(!issueKey||!itemId){showMessage('This comment control is not linked to a verified custom card.',true);return}
  const token=await miro.board.getIdToken();
  const response=await fetch('/jira-comments?issueKey='+encodeURIComponent(issueKey)+'&itemId='+encodeURIComponent(itemId),{headers:{Authorization:'Bearer '+token}});
  const result=await response.json().catch(()=>null);
  if(!response.ok||!result||!result.ok){showMessage(result&&result.reason||'Could not load Jira comments.',true);return}
  render(result.comments||[]);
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