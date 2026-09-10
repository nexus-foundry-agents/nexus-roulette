/**
 * Resolve pointer regions inside the zero cells of the rendered table.
 * This is kept pure so the module declaration can be checked against the controls players can use.
 */
export function zeroCellBet(zeroLabel,pointerX,pointerY,isAmerican){
  if(zeroLabel==='0'){
    if(pointerY>0.7&&isAmerican)return {type:'split',target:'0-00'};
    if(pointerX>0.5&&pointerY<0.5)return {type:'split',target:'0-3'};
    if(pointerX>0.5)return {type:'split',target:'0-2'};
    return {type:'straight',target:'0'};
  }
  if(zeroLabel==='00'&&isAmerican){
    if(pointerY<0.25)return {type:'split',target:'0-00'};
    if(pointerX>0.5&&pointerY<0.5)return {type:'split',target:'00-2'};
    if(pointerX>0.5)return {type:'split',target:'00-1'};
    return {type:'straight',target:'00'};
  }
  return {type:'straight',target:String(zeroLabel)};
}

export const ROULETTE_BOARD_ROWS = [
  [3,6,9,12,15,18,21,24,27,30,33,36],
  [2,5,8,11,14,17,20,23,26,29,32,35],
  [1,4,7,10,13,16,19,22,25,28,31,34],
];

export function detectRouletteGridBet(numStr,offsetX,offsetY,cellW,cellH){
  if(!cellW||!cellH)return {type:'straight',target:numStr};
  let r=-1,c=-1;
  ROULETTE_BOARD_ROWS.forEach(function(row,rowIndex){
    const columnIndex=row.indexOf(Number(numStr));
    if(columnIndex>=0){r=rowIndex;c=columnIndex;}
  });
  if(r<0)return {type:'straight',target:numStr};
  const edgePct=0.30;
  const nearRight=offsetX>cellW*(1-edgePct),nearLeft=offsetX<cellW*edgePct;
  const nearBottom=offsetY>cellH*(1-edgePct),nearTop=offsetY<cellH*edgePct;
  const hasRight=c<11,hasBelow=r<2,hasAbove=r>0,hasLeft=c>0;
  const target=(values)=>values.sort(function(a,b){return a-b;}).join('-');

  if(nearRight&&nearBottom&&hasRight&&hasBelow)return {type:'corner',target:target([ROULETTE_BOARD_ROWS[r][c],ROULETTE_BOARD_ROWS[r][c+1],ROULETTE_BOARD_ROWS[r+1][c],ROULETTE_BOARD_ROWS[r+1][c+1]])};
  if(nearRight&&nearTop&&hasRight&&hasAbove)return {type:'corner',target:target([ROULETTE_BOARD_ROWS[r-1][c],ROULETTE_BOARD_ROWS[r-1][c+1],ROULETTE_BOARD_ROWS[r][c],ROULETTE_BOARD_ROWS[r][c+1]])};
  if(nearLeft&&nearBottom&&hasLeft&&hasBelow)return {type:'corner',target:target([ROULETTE_BOARD_ROWS[r][c-1],ROULETTE_BOARD_ROWS[r][c],ROULETTE_BOARD_ROWS[r+1][c-1],ROULETTE_BOARD_ROWS[r+1][c]])};
  if(nearLeft&&nearTop&&hasLeft&&hasAbove)return {type:'corner',target:target([ROULETTE_BOARD_ROWS[r-1][c-1],ROULETTE_BOARD_ROWS[r-1][c],ROULETTE_BOARD_ROWS[r][c-1],ROULETTE_BOARD_ROWS[r][c]])};
  if(nearBottom&&!hasBelow&&nearRight&&hasRight)return {type:'line',target:target([ROULETTE_BOARD_ROWS[0][c],ROULETTE_BOARD_ROWS[1][c],ROULETTE_BOARD_ROWS[2][c],ROULETTE_BOARD_ROWS[0][c+1],ROULETTE_BOARD_ROWS[1][c+1],ROULETTE_BOARD_ROWS[2][c+1]])};
  if(nearBottom&&!hasBelow&&nearLeft&&hasLeft)return {type:'line',target:target([ROULETTE_BOARD_ROWS[0][c-1],ROULETTE_BOARD_ROWS[1][c-1],ROULETTE_BOARD_ROWS[2][c-1],ROULETTE_BOARD_ROWS[0][c],ROULETTE_BOARD_ROWS[1][c],ROULETTE_BOARD_ROWS[2][c]])};
  if(nearLeft&&!hasLeft){
    if(nearBottom&&!hasBelow)return {type:'basket',target:'0-00-1-2-3'};
    if(nearTop&&hasAbove){
      if(r===1)return {type:'street',target:'0-2-3'};
      if(r===2)return {type:'street',target:'00-1-2'};
    }
    if(nearBottom&&hasBelow){
      if(r===0)return {type:'street',target:'0-2-3'};
      if(r===1)return {type:'street',target:'00-1-2'};
    }
    if(r===0)return {type:'split',target:'0-3'};
    if(r===1)return {type:'street',target:'0-00-2'};
    if(r===2)return {type:'split',target:'00-1'};
  }
  if(nearBottom&&!hasBelow)return {type:'street',target:target([ROULETTE_BOARD_ROWS[0][c],ROULETTE_BOARD_ROWS[1][c],ROULETTE_BOARD_ROWS[2][c]])};
  if(nearLeft&&hasLeft)return {type:'split',target:target([ROULETTE_BOARD_ROWS[r][c-1],ROULETTE_BOARD_ROWS[r][c]])};
  if(nearRight&&hasRight)return {type:'split',target:target([ROULETTE_BOARD_ROWS[r][c],ROULETTE_BOARD_ROWS[r][c+1]])};
  if(nearBottom&&hasBelow)return {type:'split',target:target([ROULETTE_BOARD_ROWS[r][c],ROULETTE_BOARD_ROWS[r+1][c]])};
  if(nearTop&&hasAbove)return {type:'split',target:target([ROULETTE_BOARD_ROWS[r-1][c],ROULETTE_BOARD_ROWS[r][c]])};
  return {type:'straight',target:numStr};
}
