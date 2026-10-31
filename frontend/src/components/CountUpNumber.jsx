import {useLayoutEffect,useRef} from 'react';

const duration=600;

// Only the aria-hidden presentation changes per frame. React and assistive
// technology always receive the real, fully formatted value.
export function CountUpNumber({value,format=String}){
  const visual=useRef(null),animation=useRef(null);
  const finalText=format(value);

  useLayoutEffect(()=>{
    const element=visual.current,target=Number(value);
    const motion=window.matchMedia('(prefers-reduced-motion: reduce)');
    const firstRun=!animation.current;
    if(firstRun)animation.current={value,start:performance.now(),done:false};
    const run=animation.current;
    if(run.done||run.value!==value||motion.matches||value==null||!Number.isFinite(target)||target===0){
      element.textContent=finalText;
      run.done=true;
      return;
    }

    let frame;
    const finish=()=>{
      cancelAnimationFrame(frame);
      run.done=true;
      element.textContent=finalText;
    };
    const onMotionChange=event=>{if(event.matches)finish();};
    const tick=now=>{
      const progress=Math.min(1,Math.max(0,(now-run.start)/duration));
      if(progress===1){finish();return;}
      element.textContent=format(target*(1-(1-progress)**3));
      frame=requestAnimationFrame(tick);
    };

    // Keep the original timeline through StrictMode effect replays; cleanup
    // cancels only the scheduled frame, never resets progress to zero.
    const progress=Math.min(1,Math.max(0,(performance.now()-run.start)/duration));
    element.textContent=format(firstRun?0:target*(1-(1-progress)**3));
    motion.addEventListener('change',onMotionChange);
    frame=requestAnimationFrame(tick);
    return()=>{
      cancelAnimationFrame(frame);
      motion.removeEventListener('change',onMotionChange);
    };
  },[value,format,finalText]);

  return <span className="count-up"><span className="sr-only">{finalText}</span><span className="count-up-reserve" aria-hidden="true">{finalText}</span><span className="count-up-value" aria-hidden="true" ref={visual}>{finalText}</span></span>;
}
