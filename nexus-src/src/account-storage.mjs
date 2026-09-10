/** Attempt one browser-storage write and report the actual persistence result. */
export function writeRouletteStorage(storage,key,state,onFailure){
  if(!key)return false;
  try{
    storage.setItem(key,JSON.stringify(state));
    return true;
  }catch(error){
    if(onFailure)onFailure(error);
    return false;
  }
}
